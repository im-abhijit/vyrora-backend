import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
  });
}

const db = admin.firestore();

async function generateReviewFromIngredients(ingredients) {
  const prompt = `Skincare expert. Generate 3 short review bullets (10-12 words).
Cover benefits, skin-type suitability, actives impact, irritation risk.
Return ONLY a JSON array of strings.
Ingredients: ${JSON.stringify(ingredients)}`;

  if (!process.env.XAI_API_KEY) {
    throw new Error("Missing XAI_API_KEY");
  }

  const model = process.env.GROK_MODEL || "grok-4";
  const response = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.XAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      stream: false,
      temperature: 0.7,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Grok API error (${response.status}): ${errorText || "Unknown error"}`
    );
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;

  if (!text) {
    throw new Error("Grok API returned empty response.");
  }

  let parsed;
  try {
    parsed = JSON.parse(String(text).trim());
  } catch (error) {
    throw new Error(`Failed to parse Grok response: ${text}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Grok response is not a JSON array.");
  }

  return parsed.map((item) => String(item));
}

export async function handler(event) {
  const headers = {
    "Access-Control-Allow-Origin": "http://localhost:3000",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers };
  }

  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, headers, body: "Method Not Allowed" };
    }

    const body = event.body ? JSON.parse(event.body) : {};
    const { productId1, productId2 } = body;

    if (!productId1 || !productId2) {
      return {
        statusCode: 400,
        headers,
        body: "productId1 and productId2 are required",
      };
    }

    const [doc1, doc2] = await Promise.all([
      db.collection("products").doc(productId1).get(),
      db.collection("products").doc(productId2).get(),
    ]);

    const ingredients1 = doc1.exists ? doc1.data()?.ingredients || [] : [];
    const ingredients2 = doc2.exists ? doc2.data()?.ingredients || [] : [];

    const [review1, review2] = await Promise.all([
      generateReviewFromIngredients(ingredients1),
      generateReviewFromIngredients(ingredients2),
    ]);

    await Promise.all([
      db
        .collection("products")
        .doc(productId1)
        .set({ ai_review: review1 }, { merge: true }),
      db
        .collection("products")
        .doc(productId2)
        .set({ ai_review: review2 }, { merge: true }),
    ]);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        [productId1]: review1,
        [productId2]: review2,
      }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers,
      body: error.message,
    };
  }
}