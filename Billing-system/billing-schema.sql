-- migrations/001_billing_schema.sql

-- Billing tiers table
CREATE TABLE billing_tiers (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    price DECIMAL(10, 2) NOT NULL,
    stripe_price_id VARCHAR(255),
    client_limit INTEGER NOT NULL DEFAULT -1, -- -1 means unlimited
    features JSONB DEFAULT '[]',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert default tiers
INSERT INTO billing_tiers (id, name, price, client_limit, features) VALUES
('starter', 'Starter', 29.00, 10, '["Core features", "Email support", "Basic analytics"]'),
('professional', 'Professional', 79.00, 50, '["All features", "Custom branding", "Priority support", "Advanced analytics"]'),
('scale', 'Scale', 149.00, 150, '["Everything in Professional", "API access", "White label options", "Custom integrations"]'),
('enterprise', 'Enterprise', 299.00, -1, '["Everything in Scale", "Unlimited clients", "Multi-specialist accounts", "Dedicated support"]');

-- Update specialists table for billing
ALTER TABLE specialists ADD COLUMN IF NOT EXISTS billing_tier_id VARCHAR(50) REFERENCES billing_tiers(id) DEFAULT 'starter';
ALTER TABLE specialists ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255);
ALTER TABLE specialists ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(255);
ALTER TABLE specialists ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(50) DEFAULT 'trialing';
ALTER TABLE specialists ADD COLUMN IF NOT EXISTS subscription_start_date TIMESTAMP;
ALTER TABLE specialists ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMP;
ALTER TABLE specialists ADD COLUMN IF NOT EXISTS cancellation_date TIMESTAMP;
ALTER TABLE specialists ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
ALTER TABLE specialists ADD COLUMN IF NOT EXISTS is_restricted BOOLEAN DEFAULT false;
ALTER TABLE specialists ADD COLUMN IF NOT EXISTS restriction_reason VARCHAR(255);
ALTER TABLE specialists ADD COLUMN IF NOT EXISTS restricted_at TIMESTAMP;
ALTER TABLE specialists ADD COLUMN IF NOT EXISTS client_count INTEGER DEFAULT 0;
ALTER TABLE specialists ADD COLUMN IF NOT EXISTS last_limit_check TIMESTAMP;

-- Update clients table for soft limits (NEVER DELETE DATA)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS archived_reason VARCHAR(255);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS marked_for_cleanup BOOLEAN DEFAULT false;

-- Billing events log (for audit trail)
CREATE TABLE billing_events (
    id SERIAL PRIMARY KEY,
    specialist_id INTEGER REFERENCES specialists(id),
    event_type VARCHAR(100) NOT NULL,
    event_data JSONB,
    stripe_event_id VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Invoices table
CREATE TABLE invoices (
    id SERIAL PRIMARY KEY,
    invoice_number VARCHAR(50) UNIQUE NOT NULL,
    specialist_id INTEGER REFERENCES specialists(id),
    client_id INTEGER REFERENCES clients(id),
    stripe_invoice_id VARCHAR(255),
    amount DECIMAL(10, 2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'USD',
    status VARCHAR(50) NOT NULL, -- draft, pending, paid, overdue, void
    due_date DATE,
    paid_date DATE,
    items JSONB DEFAULT '[]',
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Payment methods
CREATE TABLE payment_methods (
    id SERIAL PRIMARY KEY,
    specialist_id INTEGER REFERENCES specialists(id),
    stripe_payment_method_id VARCHAR(255),
    type VARCHAR(50), -- card, bank_account
    last4 VARCHAR(4),
    brand VARCHAR(50), -- visa, mastercard, etc
    exp_month INTEGER,
    exp_year INTEGER,
    is_default BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Usage tracking (for potential usage-based billing)
CREATE TABLE usage_tracking (
    id SERIAL PRIMARY KEY,
    specialist_id INTEGER REFERENCES specialists(id),
    metric_name VARCHAR(100) NOT NULL,
    metric_value INTEGER NOT NULL,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(specialist_id, metric_name, period_start)
);

-- Scheduled tasks (for automated actions)
CREATE TABLE scheduled_tasks (
    id SERIAL PRIMARY KEY,
    task_type VARCHAR(100) NOT NULL,
    specialist_id INTEGER REFERENCES specialists(id),
    client_id INTEGER REFERENCES clients(id),
    execute_at TIMESTAMP NOT NULL,
    executed_at TIMESTAMP,
    status VARCHAR(50) DEFAULT 'pending',
    payload JSONB,
    result JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX idx_specialists_billing ON specialists(billing_tier_id, is_restricted);
CREATE INDEX idx_specialists_stripe ON specialists(stripe_customer_id, stripe_subscription_id);
CREATE INDEX idx_clients_active ON clients(specialist_id, is_active, is_archived);
CREATE INDEX idx_clients_activity ON clients(specialist_id, last_activity);
CREATE INDEX idx_billing_events_specialist ON billing_events(specialist_id, created_at);
CREATE INDEX idx_scheduled_tasks_pending ON scheduled_tasks(execute_at, status) WHERE status = 'pending';

-- Triggers for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_billing_tiers_updated_at BEFORE UPDATE ON billing_tiers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_invoices_updated_at BEFORE UPDATE ON invoices
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Function to update client count
CREATE OR REPLACE FUNCTION update_client_count()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.is_active != OLD.is_active) THEN
        UPDATE specialists 
        SET client_count = (
            SELECT COUNT(*) 
            FROM clients 
            WHERE specialist_id = NEW.specialist_id 
            AND is_active = true
        )
        WHERE id = NEW.specialist_id;
    END IF;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_specialist_client_count 
AFTER INSERT OR UPDATE ON clients
FOR EACH ROW EXECUTE FUNCTION update_client_count();

-- View for billing dashboard
CREATE VIEW billing_overview AS
SELECT 
    s.id,
    s.name,
    s.email,
    bt.name as tier_name,
    bt.price as tier_price,
    bt.client_limit,
    s.client_count,
    s.is_restricted,
    s.subscription_status,
    s.subscription_start_date,
    s.trial_ends_at,
    CASE 
        WHEN bt.client_limit = -1 THEN 'Unlimited'
        ELSE ROUND((s.client_count::numeric / bt.client_limit) * 100, 2)::text || '%'
    END as usage_percentage,
    COUNT(DISTINCT i.id) FILTER (WHERE i.status = 'paid') as paid_invoices,
    COUNT(DISTINCT i.id) FILTER (WHERE i.status = 'pending') as pending_invoices,
    SUM(i.amount) FILTER (WHERE i.status = 'paid') as total_revenue
FROM specialists s
LEFT JOIN billing_tiers bt ON s.billing_tier_id = bt.id
LEFT JOIN invoices i ON s.id = i.specialist_id
GROUP BY s.id, s.name, s.email, bt.name, bt.price, bt.client_limit, s.client_count, 
         s.is_restricted, s.subscription_status, s.subscription_start_date, s.trial_ends_at;