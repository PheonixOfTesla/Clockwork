// routes/billing.js
const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const billingService = require('../services/billingService');
const { authenticateToken } = require('../middleware/auth');
const { enforceRestrictions, handleStripeWebhook } = require('../middleware/billingRestrictions');
const db = require('../config/database');

// Get billing tiers
router.get('/tiers', async (req, res) => {
  try {
    const tiers = await db.query(
      'SELECT * FROM billing_tiers WHERE is_active = true ORDER BY price ASC'
    );
    
    res.json({
      tiers: tiers.rows,
      features: {
        starter: ['Up to 10 clients', 'Core features', 'Email support'],
        professional: ['Up to 50 clients', 'All features', 'Priority support', 'Custom branding'],
        scale: ['Up to 150 clients', 'API access', 'White label', 'Advanced analytics'],
        enterprise: ['Unlimited clients', 'Multi-specialist', 'Dedicated support', 'Custom features']
      }
    });
  } catch (error) {
    console.error('Error fetching tiers:', error);
    res.status(500).json({ error: 'Failed to fetch billing tiers' });
  }
});

// Get current billing status
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const specialistId = req.user.id;
    
    const result = await db.query(
      `SELECT s.*, bt.*, 
        (SELECT COUNT(*) FROM clients WHERE specialist_id = s.id AND is_active = true) as active_clients,
        (SELECT SUM(amount) FROM invoices WHERE specialist_id = s.id AND status = 'paid') as total_revenue
       FROM specialists s
       LEFT JOIN billing_tiers bt ON s.billing_tier_id = bt.id
       WHERE s.id = $1`,
      [specialistId]
    );
    
    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Specialist not found' });
    }
    
    const billing = result.rows[0];
    
    // Calculate usage percentage
    const usagePercentage = billing.client_limit === -1 
      ? 0 
      : Math.round((billing.active_clients / billing.client_limit) * 100);
    
    res.json({
      tier: {
        id: billing.billing_tier_id,
        name: billing.name,
        price: billing.price,
        clientLimit: billing.client_limit,
        features: billing.features
      },
      usage: {
        activeClients: billing.active_clients,
        clientLimit: billing.client_limit,
        percentage: usagePercentage,
        isAtLimit: billing.client_limit !== -1 && billing.active_clients >= billing.client_limit,
        isNearLimit: billing.client_limit !== -1 && billing.active_clients >= billing.client_limit * 0.8
      },
      subscription: {
        status: billing.subscription_status,
        startDate: billing.subscription_start_date,
        trialEndsAt: billing.trial_ends_at,
        isRestricted: billing.is_restricted,
        restrictionReason: billing.restriction_reason
      },
      revenue: {
        total: billing.total_revenue || 0
      }
    });
  } catch (error) {
    console.error('Error fetching billing status:', error);
    res.status(500).json({ error: 'Failed to fetch billing status' });
  }
});

// Create subscription
router.post('/subscribe', authenticateToken, async (req, res) => {
  try {
    const { tierId, paymentMethodId } = req.body;
    const specialistId = req.user.id;
    
    if (!tierId || !paymentMethodId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const result = await billingService.createSubscription(
      specialistId,
      tierId,
      paymentMethodId
    );
    
    res.json({
      success: true,
      subscription: {
        id: result.subscription.id,
        status: result.subscription.status,
        trialEnd: result.subscription.trial_end
      },
      tier: result.tier
    });
  } catch (error) {
    console.error('Error creating subscription:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update subscription (upgrade/downgrade)
router.post('/upgrade', authenticateToken, async (req, res) => {
  try {
    const { tierId } = req.body;
    const specialistId = req.user.id;
    
    if (!tierId) {
      return res.status(400).json({ error: 'Missing tier ID' });
    }
    
    const result = await billingService.updateSubscription(specialistId, tierId);
    
    res.json({
      success: true,
      subscription: result.subscription,
      tier: result.tier,
      message: 'Subscription updated successfully'
    });
  } catch (error) {
    console.error('Error updating subscription:', error);
    res.status(500).json({ error: error.message });
  }
});

// Cancel subscription
router.post('/cancel', authenticateToken, async (req, res) => {
  try {
    const { reason } = req.body;
    const specialistId = req.user.id;
    
    const result = await billingService.cancelSubscription(specialistId, reason);
    
    res.json({
      success: true,
      message: 'Subscription will be canceled at the end of the billing period',
      cancelDate: result.cancelDate
    });
  } catch (error) {
    console.error('Error canceling subscription:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get invoices
router.get('/invoices', authenticateToken, async (req, res) => {
  try {
    const specialistId = req.user.id;
    const { status, limit = 20, offset = 0 } = req.query;
    
    let query = `
      SELECT * FROM invoices 
      WHERE specialist_id = $1
    `;
    const params = [specialistId];
    
    if (status) {
      query += ' AND status = $2';
      params.push(status);
    }
    
    query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(limit, offset);
    
    const invoices = await db.query(query, params);
    
    res.json({
      invoices: invoices.rows,
      total: invoices.rowCount
    });
  } catch (error) {
    console.error('Error fetching invoices:', error);
    res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

// Create payment intent for setup
router.post('/setup-intent', authenticateToken, async (req, res) => {
  try {
    const specialistId = req.user.id;
    
    // Get or create Stripe customer
    const specialist = await db.query(
      'SELECT * FROM specialists WHERE id = $1',
      [specialistId]
    );
    
    let customerId = specialist.rows[0].stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: specialist.rows[0].email,
        name: specialist.rows[0].name,
        metadata: { specialistId }
      });
      customerId = customer.id;
      
      await db.query(
        'UPDATE specialists SET stripe_customer_id = $1 WHERE id = $2',
        [customerId, specialistId]
      );
    }
    
    // Create setup intent
    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ['card'],
      metadata: { specialistId }
    });
    
    res.json({
      clientSecret: setupIntent.client_secret
    });
  } catch (error) {
    console.error('Error creating setup intent:', error);
    res.status(500).json({ error: 'Failed to create setup intent' });
  }
});

// Archive inactive clients
router.post('/archive-clients', authenticateToken, enforceRestrictions, async (req, res) => {
  try {
    const specialistId = req.user.id;
    const { clientIds, reason = 'manual_archive' } = req.body;
    
    if (!clientIds || !Array.isArray(clientIds)) {
      return res.status(400).json({ error: 'Invalid client IDs' });
    }
    
    // Archive clients (never delete!)
    const result = await db.query(
      `UPDATE clients 
       SET is_active = false,
           is_archived = true,
           archived_at = NOW(),
           archived_reason = $1
       WHERE id = ANY($2) AND specialist_id = $3
       RETURNING id, name`,
      [reason, clientIds, specialistId]
    );
    
    // Check limits after archiving
    await billingService.checkClientLimits(specialistId);
    
    res.json({
      success: true,
      archived: result.rows,
      message: `${result.rowCount} clients archived successfully`
    });
  } catch (error) {
    console.error('Error archiving clients:', error);
    res.status(500).json({ error: 'Failed to archive clients' });
  }
});

// Get upgrade recommendations
router.get('/recommendations', authenticateToken, async (req, res) => {
  try {
    const specialistId = req.user.id;
    
    // Get current usage and trends
    const usage = await db.query(
      `SELECT 
        s.billing_tier_id,
        s.client_count,
        bt.client_limit,
        bt.price as current_price,
        (SELECT COUNT(*) FROM clients WHERE specialist_id = s.id AND created_at > NOW() - INTERVAL '30 days') as new_clients_30d,
        (SELECT COUNT(*) FROM invoices WHERE specialist_id = s.id AND status = 'paid') as total_invoices,
        (SELECT SUM(amount) FROM invoices WHERE specialist_id = s.id AND status = 'paid') as total_revenue
       FROM specialists s
       LEFT JOIN billing_tiers bt ON s.billing_tier_id = bt.id
       WHERE s.id = $1`,
      [specialistId]
    );
    
    const data = usage.rows[0];
    const growthRate = data.new_clients_30d / Math.max(1, data.client_count - data.new_clients_30d);
    
    // Calculate recommendations
    const recommendations = [];
    
    if (data.client_limit !== -1 && data.client_count >= data.client_limit * 0.8) {
      recommendations.push({
        type: 'upgrade',
        urgency: 'high',
        reason: 'approaching_limit',
        message: `You're at ${Math.round((data.client_count / data.client_limit) * 100)}% capacity`,
        action: 'Upgrade to continue growing'
      });
    }
    
    if (growthRate > 0.2) {
      recommendations.push({
        type: 'upgrade',
        urgency: 'medium',
        reason: 'rapid_growth',
        message: `You're growing at ${Math.round(growthRate * 100)}% per month`,
        action: 'Upgrade to accommodate growth'
      });
    }
    
    if (data.total_revenue > data.current_price * 12) {
      recommendations.push({
        type: 'feature',
        urgency: 'low',
        reason: 'revenue_opportunity',
        message: 'Consider premium features to increase value',
        action: 'Explore enterprise features'
      });
    }
    
    res.json({ recommendations });
  } catch (error) {
    console.error('Error getting recommendations:', error);
    res.status(500).json({ error: 'Failed to get recommendations' });
  }
});

// Stripe webhook endpoint (raw body required)
router.post('/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);

module.exports = router;