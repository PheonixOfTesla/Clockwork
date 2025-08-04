// services/billingService.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const db = require('../config/database');
const { sendEmail } = require('./emailService');

// Billing tier configuration
const BILLING_TIERS = {
  starter: {
    id: 'starter',
    name: 'Starter',
    price: 29,
    priceId: process.env.STRIPE_PRICE_STARTER,
    clientLimit: 10,
    features: ['Core features', 'Email support', 'Basic analytics']
  },
  professional: {
    id: 'professional', 
    name: 'Professional',
    price: 79,
    priceId: process.env.STRIPE_PRICE_PROFESSIONAL,
    clientLimit: 50,
    features: ['All features', 'Custom branding', 'Priority support', 'Advanced analytics']
  },
  scale: {
    id: 'scale',
    name: 'Scale', 
    price: 149,
    priceId: process.env.STRIPE_PRICE_SCALE,
    clientLimit: 150,
    features: ['Everything in Professional', 'API access', 'White label options', 'Custom integrations']
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    price: 299,
    priceId: process.env.STRIPE_PRICE_ENTERPRISE,
    clientLimit: -1, // Unlimited
    features: ['Everything in Scale', 'Unlimited clients', 'Multi-specialist accounts', 'Dedicated support']
  }
};

class BillingService {
  // Check if specialist has reached client limit
  async checkClientLimits(specialistId) {
    try {
      // Get specialist's current tier and client count
      const specialist = await db.query(
        `SELECT s.*, bt.tier_id, bt.client_limit, 
         (SELECT COUNT(*) FROM clients WHERE specialist_id = s.id AND is_active = true) as client_count
         FROM specialists s
         LEFT JOIN billing_tiers bt ON s.billing_tier_id = bt.id
         WHERE s.id = $1`,
        [specialistId]
      );

      if (!specialist.rows[0]) {
        throw new Error('Specialist not found');
      }

      const { client_count, client_limit, tier_id } = specialist.rows[0];
      
      // Check if at or over limit
      if (client_limit !== -1 && client_count >= client_limit) {
        // Set restriction flag
        await db.query(
          `UPDATE specialists 
           SET is_restricted = true, 
               restriction_reason = 'client_limit_exceeded',
               restricted_at = NOW()
           WHERE id = $1`,
          [specialistId]
        );

        // Send notification
        await this.notifyLimitReached(specialistId, client_count, client_limit, tier_id);
        
        return { restricted: true, reason: 'client_limit_exceeded', clientCount: client_count, limit: client_limit };
      }

      // Check if approaching limit (80%)
      if (client_limit !== -1 && client_count >= client_limit * 0.8) {
        await this.notifyApproachingLimit(specialistId, client_count, client_limit);
      }

      return { restricted: false, clientCount: client_count, limit: client_limit };
    } catch (error) {
      console.error('Error checking client limits:', error);
      throw error;
    }
  }

  // Create Stripe customer and subscription
  async createSubscription(specialistId, tierId, paymentMethodId) {
    try {
      const specialist = await db.query(
        'SELECT * FROM specialists WHERE id = $1',
        [specialistId]
      );

      if (!specialist.rows[0]) {
        throw new Error('Specialist not found');
      }

      const tier = BILLING_TIERS[tierId];
      if (!tier) {
        throw new Error('Invalid tier');
      }

      // Create or retrieve Stripe customer
      let customerId = specialist.rows[0].stripe_customer_id;
      if (!customerId) {
        const customer = await stripe.customers.create({
          email: specialist.rows[0].email,
          name: specialist.rows[0].name,
          metadata: {
            specialistId: specialistId
          }
        });
        customerId = customer.id;

        // Save Stripe customer ID
        await db.query(
          'UPDATE specialists SET stripe_customer_id = $1 WHERE id = $2',
          [customerId, specialistId]
        );
      }

      // Attach payment method
      await stripe.paymentMethods.attach(paymentMethodId, {
        customer: customerId
      });

      // Set as default payment method
      await stripe.customers.update(customerId, {
        invoice_settings: {
          default_payment_method: paymentMethodId
        }
      });

      // Create subscription
      const subscription = await stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: tier.priceId }],
        metadata: {
          specialistId: specialistId,
          tierId: tierId
        },
        trial_period_days: 14, // 14-day free trial
        payment_behavior: 'default_incomplete',
        expand: ['latest_invoice.payment_intent']
      });

      // Update specialist's billing info
      await db.query(
        `UPDATE specialists 
         SET billing_tier_id = $1, 
             stripe_subscription_id = $2,
             subscription_status = $3,
             subscription_start_date = NOW(),
             is_restricted = false,
             restriction_reason = NULL
         WHERE id = $4`,
        [tierId, subscription.id, subscription.status, specialistId]
      );

      // Clear any restrictions
      await this.clearRestrictions(specialistId);

      return { subscription, tier };
    } catch (error) {
      console.error('Error creating subscription:', error);
      throw error;
    }
  }

  // Handle subscription updates (upgrades/downgrades)
  async updateSubscription(specialistId, newTierId) {
    try {
      const specialist = await db.query(
        'SELECT * FROM specialists WHERE id = $1',
        [specialistId]
      );

      if (!specialist.rows[0] || !specialist.rows[0].stripe_subscription_id) {
        throw new Error('No active subscription found');
      }

      const newTier = BILLING_TIERS[newTierId];
      if (!newTier) {
        throw new Error('Invalid tier');
      }

      // Get current subscription
      const subscription = await stripe.subscriptions.retrieve(
        specialist.rows[0].stripe_subscription_id
      );

      // Update subscription
      const updatedSubscription = await stripe.subscriptions.update(
        subscription.id,
        {
          items: [{
            id: subscription.items.data[0].id,
            price: newTier.priceId
          }],
          metadata: {
            tierId: newTierId
          },
          proration_behavior: 'create_prorations'
        }
      );

      // Update database
      await db.query(
        'UPDATE specialists SET billing_tier_id = $1 WHERE id = $2',
        [newTierId, specialistId]
      );

      // Check if downgrading and need to enforce limits
      await this.checkClientLimits(specialistId);

      return { subscription: updatedSubscription, tier: newTier };
    } catch (error) {
      console.error('Error updating subscription:', error);
      throw error;
    }
  }

  // Cancel subscription (with grace period)
  async cancelSubscription(specialistId, reason) {
    try {
      const specialist = await db.query(
        'SELECT * FROM specialists WHERE id = $1',
        [specialistId]
      );

      if (!specialist.rows[0] || !specialist.rows[0].stripe_subscription_id) {
        throw new Error('No active subscription found');
      }

      // Cancel at period end (grace period until end of billing cycle)
      const subscription = await stripe.subscriptions.update(
        specialist.rows[0].stripe_subscription_id,
        {
          cancel_at_period_end: true,
          metadata: {
            cancellation_reason: reason
          }
        }
      );

      // Update database
      await db.query(
        `UPDATE specialists 
         SET subscription_status = 'canceling',
             cancellation_date = $1,
             cancellation_reason = $2
         WHERE id = $3`,
        [subscription.current_period_end, reason, specialistId]
      );

      // Send cancellation email with retention offer
      await this.sendCancellationEmail(specialistId, subscription.current_period_end);

      return { subscription, cancelDate: subscription.current_period_end };
    } catch (error) {
      console.error('Error canceling subscription:', error);
      throw error;
    }
  }

  // Smart archive inactive clients
  async smartArchiveClients(specialistId) {
    try {
      const result = await db.query(
        `SELECT s.*, bt.client_limit,
         (SELECT COUNT(*) FROM clients WHERE specialist_id = s.id AND is_active = true) as active_clients
         FROM specialists s
         LEFT JOIN billing_tiers bt ON s.billing_tier_id = bt.id
         WHERE s.id = $1 AND s.is_restricted = true`,
        [specialistId]
      );

      if (!result.rows[0]) return;

      const { client_limit, active_clients } = result.rows[0];
      
      if (client_limit !== -1 && active_clients > client_limit) {
        // Find candidates for archiving (inactive for 90+ days)
        const candidates = await db.query(
          `SELECT id, name, email, last_activity 
           FROM clients 
           WHERE specialist_id = $1 
             AND is_active = true
             AND (last_activity < NOW() - INTERVAL '90 days' OR last_activity IS NULL)
           ORDER BY last_activity ASC NULLS FIRST
           LIMIT $2`,
          [specialistId, active_clients - client_limit]
        );

        if (candidates.rows.length > 0) {
          // Notify specialist before archiving
          await this.notifyPendingArchive(specialistId, candidates.rows);

          // Schedule archiving for 7 days later
          for (const client of candidates.rows) {
            await db.query(
              `INSERT INTO scheduled_tasks (task_type, specialist_id, client_id, execute_at, payload)
               VALUES ('archive_client', $1, $2, NOW() + INTERVAL '7 days', $3)`,
              [specialistId, client.id, JSON.stringify({ reason: 'auto_archived_billing_limit' })]
            );
          }
        }
      }
    } catch (error) {
      console.error('Error in smart archive:', error);
    }
  }

  // Notification methods
  async notifyLimitReached(specialistId, clientCount, limit, tierId) {
    const specialist = await db.query('SELECT * FROM specialists WHERE id = $1', [specialistId]);
    const nextTier = this.getNextTier(tierId);

    await sendEmail({
      to: specialist.rows[0].email,
      subject: 'Client Limit Reached - Upgrade to Continue Growing',
      template: 'limit-reached',
      data: {
        name: specialist.rows[0].name,
        currentClients: clientCount,
        limit: limit,
        nextTier: nextTier,
        upgradeUrl: `${process.env.APP_URL}/billing/upgrade`
      }
    });
  }

  async notifyApproachingLimit(specialistId, clientCount, limit) {
    const specialist = await db.query('SELECT * FROM specialists WHERE id = $1', [specialistId]);
    const percentUsed = Math.round((clientCount / limit) * 100);

    await sendEmail({
      to: specialist.rows[0].email,
      subject: `You're at ${percentUsed}% of your client limit`,
      template: 'approaching-limit',
      data: {
        name: specialist.rows[0].name,
        currentClients: clientCount,
        limit: limit,
        percentUsed: percentUsed,
        remaining: limit - clientCount
      }
    });
  }

  async notifyPendingArchive(specialistId, clients) {
    const specialist = await db.query('SELECT * FROM specialists WHERE id = $1', [specialistId]);

    await sendEmail({
      to: specialist.rows[0].email,
      subject: 'Action Required: Inactive Clients Will Be Archived',
      template: 'pending-archive',
      data: {
        name: specialist.rows[0].name,
        clients: clients,
        archiveDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toLocaleDateString()
      }
    });
  }

  // Helper methods
  getNextTier(currentTierId) {
    const tiers = Object.keys(BILLING_TIERS);
    const currentIndex = tiers.indexOf(currentTierId);
    return currentIndex < tiers.length - 1 ? BILLING_TIERS[tiers[currentIndex + 1]] : null;
  }

  async clearRestrictions(specialistId) {
    await db.query(
      `UPDATE specialists 
       SET is_restricted = false, 
           restriction_reason = NULL,
           restricted_at = NULL
       WHERE id = $1`,
      [specialistId]
    );
  }

  // Data retention policy
  async enforceDataRetention() {
    // Never delete client data, but mark for potential cleanup after 90 days
    await db.query(
      `UPDATE clients 
       SET marked_for_cleanup = true 
       WHERE specialist_id IN (
         SELECT id FROM specialists 
         WHERE subscription_status = 'canceled' 
         AND cancellation_date < NOW() - INTERVAL '90 days'
       )`
    );
  }
}

module.exports = new BillingService();