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

async function getRawBody(req) {
  return await new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const sig = req.headers["stripe-signature"];

  let event;

  try {
    const rawBody = await getRawBody(req);

    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;

        const email = session.customer_details?.email || session.customer_email;
        const customerId = session.customer;
        const subscriptionId = session.subscription;

        if (!email) break;

        await supabase.from("stripe_customers").upsert(
          {
            email,
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
            status: "active"
          },
          { onConflict: "email" }
        );

        try {
          await supabase.auth.admin.inviteUserByEmail(email);
        } catch (inviteError) {
          console.log("Invite error:", inviteError.message);
        }

        break;
      }

      case "invoice.payment_succeeded": {
        const invoice = event.data.object;

        const email = invoice.customer_email;
        const customerId = invoice.customer;
        const subscriptionId = invoice.subscription;

        if (!email) break;

        await supabase.from("stripe_customers").upsert(
          {
            email,
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
            status: "active"
          },
          { onConflict: "email" }
        );

        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object;
        const email = invoice.customer_email;

        if (!email) break;

        await supabase
          .from("stripe_customers")
          .update({ status: "past_due" })
          .eq("email", email);

        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object;

        await supabase
          .from("stripe_customers")
          .update({ status: "canceled" })
          .eq("stripe_subscription_id", subscription.id);

        break;
      }

      default:
        break;
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error("Webhook processing error:", error.message);
    return res.status(500).json({ error: error.message });
  }
}
