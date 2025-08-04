# ClockWork Billing System - Complete Implementation

## 📁 File Structure

Here's where each file should be placed in your project:

```
clockwork-backend/
├── config/
│   └── database.js                 # Database configuration
├── middleware/
│   ├── auth.js                     # (existing)
│   └── billingRestrictions.js      # Billing enforcement middleware
├── services/
│   ├── billingService.js           # Core billing logic
│   ├── emailService.js             # Email notifications
│   └── scheduledTasks.js           # Automated tasks runner
├── routes/
│   ├── billing.js                  # Billing API endpoints
│   └── ... (other routes)
├── migrations/
│   └── 001_billing_schema.sql      # Database schema
├── scripts/
│   └── migrate.js                  # Migration runner
├── .env                            # Environment variables
├── .env.example                    # Environment template
└── server.js                       # Updated with billing integration

Clockwork-frontend/
├── src/
│   └── (your existing structure - add components as shown)
├── public/
│   └── index.html                  # Add Stripe script tag here
└── .env                            # Frontend environment variables
```

## 🚀 Quick Start Implementation

### 1. Backend Setup (15 minutes)

```bash
# Navigate to backend
cd clockwork-backend

# Install dependencies
npm install stripe node-cron nodemailer dotenv
npm install -D concurrently

# Copy environment template
cp .env.example .env

# Edit .env with your values
# IMPORTANT: Add your Stripe keys and SMTP settings

# Create migrations folder
mkdir -p migrations scripts

# Copy all the provided files to their respective locations

# Run database migrations
npm run migrate
```

### 2. Stripe Setup (10 minutes)

1. Go to [Stripe Dashboard](https://dashboard.stripe.com)
2. Create products and prices:
   ```
   Starter - $29/month
   Professional - $79/month  
   Scale - $149/month
   Enterprise - $299/month
   ```
3. Copy the price IDs to your .env file
4. Set up webhook endpoint: `https://yourdomain.com/api/billing/webhook`
5. Copy webhook signing secret to .env

### 3. Frontend Integration (20 minutes)

```html
<!-- Add to public/index.html in <head> -->
<script src="https://js.stripe.com/v3/"></script>
```

```javascript
// Add to your main App component
{activeTab === 'billing' && <BillingDashboard />}

// Import the billing components
// Add ClientLimitWarning to client management pages
// Add BillingHeader to navigation
```

### 4. Email Setup (5 minutes)

For Gmail:
1. Enable 2-factor authentication
2. Generate app-specific password
3. Add to .env:
   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USER=your-email@gmail.com
   SMTP_PASS=your-app-specific-password
   ```

## 🧪 Testing Checklist

### Test Client Limits
- [ ] Create account with Starter plan (10 clients)
- [ ] Add 8 clients - see approaching warning
- [ ] Add 10 clients - see at limit warning  
- [ ] Try adding 11th - blocked with upgrade prompt
- [ ] Archive a client - can add new one

### Test Billing Flow
- [ ] View billing dashboard
- [ ] Click upgrade to Professional
- [ ] Enter test card: 4242 4242 4242 4242
- [ ] Complete upgrade
- [ ] Verify limit increased to 50

### Test Restrictions
- [ ] Cancel subscription
- [ ] Verify can still access existing clients
- [ ] Verify cannot add new clients
- [ ] Verify data is preserved

### Test Webhooks
```bash
# In a new terminal
stripe listen --forward-to localhost:3001/api/billing/webhook

# Trigger test events
stripe trigger payment_intent.succeeded
```

## 🔧 Configuration Options

### Billing Tiers
Edit in `migrations/001_billing_schema.sql` or update via database:
```sql
UPDATE billing_tiers 
SET price = 39.00, client_limit = 15 
WHERE id = 'starter';
```

### Grace Periods
In `.env`:
```
TRIAL_DAYS=14
GRACE_PERIOD_DAYS=7
```

### Email Templates
Customize in `services/emailService.js`

### Archive Settings
In `scheduledTasks.js`, adjust the 90-day inactive period

## 📊 Monitoring & Analytics

### Key Metrics to Track
```sql
-- Monthly Recurring Revenue (MRR)
SELECT SUM(bt.price) as mrr
FROM specialists s
JOIN billing_tiers bt ON s.billing_tier_id = bt.id
WHERE s.subscription_status = 'active';

-- Tier Distribution
SELECT bt.name, COUNT(*) as count
FROM specialists s
JOIN billing_tiers bt ON s.billing_tier_id = bt.id
GROUP BY bt.name;

-- Usage Rate
SELECT 
  AVG(CASE 
    WHEN bt.client_limit = -1 THEN 0
    ELSE (s.client_count::float / bt.client_limit) * 100
  END) as avg_usage_percentage
FROM specialists s
JOIN billing_tiers bt ON s.billing_tier_id = bt.id;
```

### Webhook Monitoring
```sql
-- Recent webhook events
SELECT * FROM billing_events 
ORDER BY created_at DESC 
LIMIT 20;

-- Failed tasks
SELECT * FROM scheduled_tasks 
WHERE status = 'failed' 
ORDER BY created_at DESC;
```

## 🚨 Common Issues & Solutions

### "Cannot read property 'rows' of undefined"
- Check database connection in .env
- Ensure migrations have run
- Verify table names match

### Stripe webhook 400 error
- Raw body parsing must come BEFORE express.json()
- Verify webhook secret is correct
- Check request is using raw body

### Emails not sending
- Check SMTP credentials
- For Gmail, ensure app-specific password
- Check firewall/port 587

### Client count mismatch
Run reconciliation:
```sql
UPDATE specialists s
SET client_count = (
  SELECT COUNT(*) 
  FROM clients 
  WHERE specialist_id = s.id 
  AND is_active = true
);
```

## 🎯 Next Steps

1. **Add Annual Billing**
   - 20% discount for annual plans
   - Modify Stripe products

2. **Usage-Based Add-ons**
   - SMS notifications: $0.10/message
   - Additional storage: $5/GB
   - API calls: $0.001/call

3. **Admin Dashboard**
   - MRR tracking
   - Churn analysis
   - Growth metrics

4. **Referral System**
   - 20% commission for referrals
   - Tracking codes
   - Automated payouts

## 💡 Revenue Optimization Tips

1. **Show value before limits**
   - Wait until 5+ clients before showing warnings
   - Highlight features they're using

2. **Smart upgrade prompts**
   - After completing 10 workouts
   - When adding successful client
   - Monthly progress milestones

3. **Retention tactics**
   - Annual plan discount
   - Loyalty rewards
   - Feature unlocks over time

Remember: **NEVER DELETE CLIENT DATA!** This builds trust and reduces support burden.

## 📞 Support

For implementation help:
- Check error logs in `billing_events` table
- Monitor `scheduled_tasks` for failures  
- Test with Stripe CLI for webhook issues

Your billing system is now ready to generate predictable, recurring revenue! 🚀