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
  const prompt = `You are a skincare expert.
Based on the following ingredient list, generate 5 short bullet point review insights.
Focus on:

* skin benefits
* suitability for oily/dry/acne skin
* active ingredients impact
* possible irritation risks
Return ONLY a JSON array of strings.

Ingredients: ${JSON.stringify(ingredients)}`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }],
          },
        ],
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Gemini API error (${response.status}): ${errorText || "Unknown error"}`
    );
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    throw new Error("Gemini API returned empty response.");
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Failed to parse Gemini response: ${text}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Gemini response is not a JSON array.");
  }

  return parsed.map((item) => String(item));
}

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    const body = event.body ? JSON.parse(event.body) : {};
    const { productId1, productId2 } = body;

    if (!productId1 || !productId2) {
      return {
        statusCode: 400,
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
      db.collection("products").doc(productId1).update({ ai_review: review1 }),
      db.collection("products").doc(productId2).update({ ai_review: review2 }),
    ]);

    return {
      statusCode: 200,
      body: JSON.stringify({
        productId1: review1,
        productId2: review2,
      }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: error.message,
    };
  }
}
