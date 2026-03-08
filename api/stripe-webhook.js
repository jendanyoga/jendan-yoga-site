import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export const config = {
  api: {
    bodyParser: false
  }
};

export default async function handler(req, res) {
  const sig = req.headers["stripe-signature"];

  let event;

  try {
    const rawBody = await new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => {
        data += chunk;
      });
      req.on("end", () => {
        resolve(Buffer.from(data));
      });
    });

    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );

  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {

    const session = event.data.object;

    const email = session.customer_details.email;
    const customer = session.customer;
    const subscription = session.subscription;

    await supabase.from("stripe_customers").insert([
      {
        email: email,
        stripe_customer_id: customer,
        stripe_subscription_id: subscription
      }
    ]);

    await supabase.auth.admin.createUser({
      email: email,
      email_confirm: true
    });
  }

  res.status(200).json({ received: true });
}
