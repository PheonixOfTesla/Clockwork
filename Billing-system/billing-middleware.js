// middleware/billingRestrictions.js
const db = require('../config/database');
const billingService = require('../services/billingService');

// Middleware to enforce billing restrictions
const enforceRestrictions = async (req, res, next) => {
  try {
    const specialistId = req.user.id; // Assuming user is attached by auth middleware
    
    // Get specialist's restriction status
    const result = await db.query(
      `SELECT s.is_restricted, s.restriction_reason, s.client_count,
              bt.name as tier_name, bt.client_limit
       FROM specialists s
       LEFT JOIN billing_tiers bt ON s.billing_tier_id = bt.id
       WHERE s.id = $1`,
      [specialistId]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Specialist not found' });
    }

    const specialist = result.rows[0];
    
    // Attach billing info to request for use in routes
    req.billing = {
      tierName: specialist.tier_name,
      clientLimit: specialist.client_limit,
      clientCount: specialist.client_count,
      isRestricted: specialist.is_restricted,
      restrictionReason: specialist.restriction_reason
    };

    // If not restricted, allow all actions
    if (!specialist.is_restricted) {
      return next();
    }

    // Define restricted actions
    const restrictedEndpoints = [
      { method: 'POST', path: '/api/clients' },                    // Create new client
      { method: 'PUT', path: /^\/api\/clients\/\d+\/activate$/ },  // Reactivate archived client
      { method: 'POST', path: '/api/clients/import' },             // Bulk import clients
      { method: 'POST', path: '/api/clients/bulk' }                // Bulk operations
    ];

    // Check if current request matches restricted endpoints
    const isRestricted = restrictedEndpoints.some(endpoint => {
      const methodMatch = req.method === endpoint.method;
      const pathMatch = endpoint.path instanceof RegExp 
        ? endpoint.path.test(req.path)
        : req.path === endpoint.path;
      return methodMatch && pathMatch;
    });

    if (isRestricted) {
      // Return detailed error with upgrade prompt
      return res.status(403).json({
        error: 'Account restricted',
        reason: specialist.restriction_reason,
        message: 'Upgrade your plan to add more clients',
        current_plan: specialist.tier_name,
        current_clients: specialist.client_count,
        client_limit: specialist.client_limit,
        upgrade_url: '/billing/upgrade',
        actions: {
          upgrade: {
            url: '/api/billing/upgrade',
            method: 'POST',
            description: 'Upgrade to a higher tier'
          },
          archive_clients: {
            url: '/api/clients/archive',
            method: 'POST',
            description: 'Archive inactive clients to free up space'
          }
        }
      });
    }

    // Allow non-restricted actions
    next();
  } catch (error) {
    console.error('Error in billing restrictions middleware:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Middleware to check limits before client operations
const checkClientLimits = async (req, res, next) => {
  try {
    // Only check on client creation or reactivation
    if (req.method === 'POST' || 
        (req.method === 'PUT' && req.path.includes('activate'))) {
      
      const specialistId = req.user.id;
      const limitCheck = await billingService.checkClientLimits(specialistId);
      
      if (limitCheck.restricted) {
        return res.status(403).json({
          error: 'Client limit exceeded',
          message: `You have reached your limit of ${limitCheck.limit} clients`,
          current_clients: limitCheck.clientCount,
          limit: limitCheck.limit,
          upgrade_url: '/billing/upgrade'
        });
      }
    }
    
    next();
  } catch (error) {
    console.error('Error checking client limits:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Middleware to track usage for potential usage-based billing
const trackUsage = async (req, res, next) => {
  try {
    const specialistId = req.user.id;
    const today = new Date().toISOString().split('T')[0];
    
    // Track API calls
    await db.query(
      `INSERT INTO usage_tracking (specialist_id, metric_name, metric_value, period_start, period_end)
       VALUES ($1, 'api_calls', 1, $2, $2)
       ON CONFLICT (specialist_id, metric_name, period_start)
       DO UPDATE SET metric_value = usage_tracking.metric_value + 1`,
      [specialistId, today, today]
    );
    
    next();
  } catch (error) {
    console.error('Error tracking usage:', error);
    // Don't block the request if tracking fails
    next();
  }
};

// Middleware to add billing headers to responses
const addBillingHeaders = (req, res, next) => {
  if (req.billing) {
    res.set({
      'X-Billing-Tier': req.billing.tierName,
      'X-Client-Count': req.billing.clientCount.toString(),
      'X-Client-Limit': req.billing.clientLimit === -1 ? 'unlimited' : req.billing.clientLimit.toString(),
      'X-Account-Restricted': req.billing.isRestricted ? 'true' : 'false'
    });
  }
  next();
};

// Webhook handler for Stripe events
const handleStripeWebhook = async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.rawBody, // Requires raw body middleware
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Log the event
  await db.query(
    'INSERT INTO billing_events (specialist_id, event_type, event_data, stripe_event_id) VALUES ($1, $2, $3, $4)',
    [event.data.object.metadata?.specialistId, event.type, event.data, event.id]
  );

  // Handle the event
  switch (event.type) {
    case 'customer.subscription.created':
      await handleSubscriptionCreated(event.data.object);
      break;
      
    case 'customer.subscription.updated':
      await handleSubscriptionUpdated(event.data.object);
      break;
      
    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(event.data.object);
      break;
      
    case 'invoice.payment_succeeded':
      await handlePaymentSucceeded(event.data.object);
      break;
      
    case 'invoice.payment_failed':
      await handlePaymentFailed(event.data.object);
      break;
      
    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  res.json({ received: true });
};

// Stripe webhook handlers
async function handleSubscriptionCreated(subscription) {
  const specialistId = subscription.metadata.specialistId;
  const tierId = subscription.metadata.tierId;
  
  await db.query(
    `UPDATE specialists 
     SET subscription_status = $1,
         is_restricted = false,
         restriction_reason = NULL,
         trial_ends_at = to_timestamp($2)
     WHERE stripe_subscription_id = $3`,
    [subscription.status, subscription.trial_end, subscription.id]
  );
  
  // Clear any restrictions
  await billingService.clearRestrictions(specialistId);
}

async function handleSubscriptionUpdated(subscription) {
  const newTierId = subscription.metadata.tierId;
  const specialistId = subscription.metadata.specialistId;
  
  // Update tier
  await db.query(
    `UPDATE specialists 
     SET billing_tier_id = $1,
         subscription_status = $2
     WHERE stripe_subscription_id = $3`,
    [newTierId, subscription.status, subscription.id]
  );
  
  // Check if limits need to be enforced
  await billingService.checkClientLimits(specialistId);
}

async function handleSubscriptionDeleted(subscription) {
  const specialistId = subscription.metadata.specialistId;
  
  // Don't delete data! Just restrict account
  await db.query(
    `UPDATE specialists 
     SET subscription_status = 'canceled',
         is_restricted = true,
         restriction_reason = 'subscription_canceled',
         cancellation_date = NOW()
     WHERE stripe_subscription_id = $1`,
    [subscription.id]
  );
  
  // Send retention email
  await billingService.sendRetentionEmail(specialistId);
}

async function handlePaymentSucceeded(invoice) {
  // Update invoice status
  await db.query(
    `UPDATE invoices 
     SET status = 'paid',
         paid_date = to_timestamp($1)
     WHERE stripe_invoice_id = $2`,
    [invoice.status_transitions.paid_at, invoice.id]
  );
}

async function handlePaymentFailed(invoice) {
  const specialistId = invoice.metadata.specialistId;
  
  // Start grace period
  await db.query(
    `UPDATE specialists 
     SET is_restricted = true,
         restriction_reason = 'payment_failed',
         restricted_at = NOW()
     WHERE stripe_customer_id = $1`,
    [invoice.customer]
  );
  
  // Send payment failed email
  await billingService.sendPaymentFailedEmail(specialistId);
}

module.exports = {
  enforceRestrictions,
  checkClientLimits,
  trackUsage,
  addBillingHeaders,
  handleStripeWebhook
};