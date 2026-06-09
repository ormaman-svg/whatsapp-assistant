'use strict';

const Stripe = require('stripe');
const { activateUser, deactivateUser, updateUser, clearCache } = require('./users');
const { sendText } = require('../utils/whatsapp');
const { hmacSign } = require('./crypto');

let stripe;

function getStripe() {
  if (!stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY not configured');
    stripe = new Stripe(key);
  }
  return stripe;
}

async function createCheckoutSession(phone, plan) {
  const priceId = plan === 'pro'
    ? process.env.STRIPE_PRO_PRICE_ID
    : process.env.STRIPE_BASIC_PRICE_ID;

  if (!priceId) throw new Error(`Stripe price ID not configured for plan: ${plan}`);

  const serviceUrl = process.env.SERVICE_URL || process.env.SERVICE_URL || 'http://localhost:3000';
  const rioNumber = process.env.WHATSAPP_PHONE_NUMBER_ID ? '' : '';

  const session = await getStripe().checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    metadata: { phone, plan },
    success_url: `${serviceUrl}/onboarding/success`,
    cancel_url: `${serviceUrl}/onboarding/cancel`,
    subscription_data: {
      metadata: { phone, plan },
    },
  });

  console.log(`[billing] Checkout session created (${plan}): ${session.id}`);
  return { url: session.url, sessionId: session.id };
}

async function createPortalSession(stripeCustomerId) {
  const serviceUrl = process.env.SERVICE_URL || process.env.SERVICE_URL || 'http://localhost:3000';

  const session = await getStripe().billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: serviceUrl,
  });

  return session.url;
}

async function getSubscriptionStatus(stripeSubscriptionId) {
  if (!stripeSubscriptionId) return null;
  const sub = await getStripe().subscriptions.retrieve(stripeSubscriptionId);
  return {
    status: sub.status,
    currentPeriodEnd: new Date(sub.current_period_end * 1000).toISOString(),
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    plan: sub.metadata?.plan || 'unknown',
  };
}

async function handleWebhookEvent(event) {
  console.log(`[billing] Webhook event: ${event.type}`);

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const phone = session.metadata?.phone;
      const plan = session.metadata?.plan || 'basic';

      if (!phone) {
        console.error('[billing] checkout.session.completed missing phone in metadata');
        return;
      }

      await activateUser(phone, {
        plan,
        stripeCustomerId: session.customer,
        stripeSubscriptionId: session.subscription,
        email: session.customer_email || session.customer_details?.email,
      });

      try {
        const serviceUrl = process.env.SERVICE_URL || process.env.SERVICE_URL || 'http://localhost:3000';
        const planName = plan === 'pro' ? 'Pro' : 'Basic';

        let welcomeMsg = `🎉 *Welcome to Rio ${planName}!*\n\n`;
        welcomeMsg += `Your subscription is now active. I'm ready to help!\n`;
        welcomeMsg += `ברוך הבא ל-Rio! המנוי שלך פעיל.\n\n`;

        if (plan === 'pro') {
          const sig = hmacSign(phone, 'oauth-start');
          const oauthLink = sig ? `${serviceUrl}/oauth/start?user=${phone}&sig=${sig}` : `${serviceUrl}/oauth/start?user=${phone}`;
          welcomeMsg += `To unlock Gmail, Calendar, and Drive features, connect your Google account:\n`;
          welcomeMsg += `${oauthLink}\n\n`;
        }

        welcomeMsg += `Type anything to get started, or try:\n`;
        welcomeMsg += `• Ask me anything\n`;
        welcomeMsg += `• Send an image to analyze\n`;
        welcomeMsg += `• Send a voice message\n`;
        welcomeMsg += `• /plan — see your plan details`;

        await sendText(phone, welcomeMsg);
      } catch (err) {
        console.error('[billing] Failed to send welcome message:', err.message);
      }

      break;
    }

    case 'customer.subscription.updated': {
      const sub = event.data.object;
      const phone = sub.metadata?.phone;
      if (!phone) return;

      const plan = sub.metadata?.plan || 'basic';

      if (sub.status === 'active') {
        await updateUser(phone, { plan, status: 'active', stripeSubscriptionId: sub.id });
        clearCache(phone);
      } else if (sub.status === 'past_due') {
        try {
          await sendText(phone, '⚠️ Your Rio subscription payment failed. Please update your payment method:\n/billing');
        } catch { /* ignore send failures */ }
      }

      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const phone = sub.metadata?.phone;
      if (!phone) return;

      await deactivateUser(phone, 'cancelled');

      try {
        await sendText(phone, 'Your Rio subscription has been cancelled. You can resubscribe anytime by messaging me.\n\nהמנוי שלך ל-Rio בוטל. תוכל להצטרף מחדש בכל עת.');
      } catch { /* ignore */ }

      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      const customerId = invoice.customer;

      try {
        const customer = await getStripe().customers.retrieve(customerId);
        const phone = customer.metadata?.phone;
        if (phone) {
          await sendText(phone, '⚠️ Payment for your Rio subscription failed. Please update your payment method to keep your account active.\n\n/billing — manage payment');
        }
      } catch (err) {
        console.error('[billing] Failed to notify about payment failure:', err.message);
      }

      break;
    }

    default:
      console.log(`[billing] Unhandled event type: ${event.type}`);
  }
}

function constructEvent(rawBody, signature) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET not configured');
  return getStripe().webhooks.constructEvent(rawBody, signature, webhookSecret);
}

module.exports = {
  createCheckoutSession,
  createPortalSession,
  getSubscriptionStatus,
  handleWebhookEvent,
  constructEvent,
};
