import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const INVITE_REDIRECT_URL =
  process.env.SUPABASE_INVITE_REDIRECT_URL ||
  "https://www.jendanyoga.net/login/create-password.html";

export const config = {
  api: { bodyParser: false }
};

async function getRawBody(req) {
  return await new Promise((resolve, reject) => {
    const chunks = [];

    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
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
      /* NEW MEMBER SIGNUP */
      case "checkout.session.completed": {
        const session = event.data.object;

        const email = session.customer_details?.email || session.customer_email;
        const customerId = session.customer;
        const subscriptionId = session.subscription;

        if (!email) break;

        const { error: memberError } = await supabase.from("members").upsert(
          {
            email,
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
            subscription_status: "active",
            grace_period_until: null
          },
          { onConflict: "email" }
        );

        if (memberError) {
          throw memberError;
        }

        try {
          const { error: inviteError } = await supabase.auth.admin.inviteUserByEmail(
            email,
            {
              redirectTo: INVITE_REDIRECT_URL
            }
          );

          if (inviteError) {
            console.error("Invite error:", inviteError.message);
          }
        } catch (inviteError) {
          console.error("Invite error:", inviteError.message);
        }

        break;
      }

      /* PAYMENT SUCCESS */
      case "invoice.payment_succeeded": {
        const invoice = event.data.object;
        const subscriptionId = invoice.subscription;

        const { error: updateError } = await supabase
          .from("members")
          .update({
            subscription_status: "active",
            grace_period_until: null
          })
          .eq("stripe_subscription_id", subscriptionId);

        if (updateError) {
          throw updateError;
        }

        break;
      }

      /* PAYMENT FAILED */
      case "invoice.payment_failed": {
        const invoice = event.data.object;
        const subscriptionId = invoice.subscription;

        const grace = new Date();
        grace.setHours(grace.getHours() + 48);

        const { error: updateError } = await supabase
          .from("members")
          .update({
            subscription_status: "past_due",
            grace_period_until: grace.toISOString()
          })
          .eq("stripe_subscription_id", subscriptionId);

        if (updateError) {
          throw updateError;
        }

        break;
      }

      /* SUBSCRIPTION UPDATED */
      case "customer.subscription.updated": {
        const subscription = event.data.object;

        if (subscription.cancel_at_period_end) {
          const { error: updateError } = await supabase
            .from("members")
            .update({
              subscription_status: "canceling"
            })
            .eq("stripe_subscription_id", subscription.id);

          if (updateError) {
            throw updateError;
          }
        }

        break;
      }

      /* SUBSCRIPTION CANCELED */
      case "customer.subscription.deleted": {
        const subscription = event.data.object;

        const { error: updateError } = await supabase
          .from("members")
          .update({
            subscription_status: "canceled"
          })
          .eq("stripe_subscription_id", subscription.id);

        if (updateError) {
          throw updateError;
        }

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
