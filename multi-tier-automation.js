// Clockwork Multi-Tier Automation System

// ==========================================
// TIER STRUCTURE & PRICING
// ==========================================

const tierStructure = {
  // 1. INDIVIDUAL CLIENT TIERS (B2C)
  individual: {
    free: {
      price: 0,
      name: "Free Explorer",
      features: [
        "Basic workout tracking",
        "3 workouts/week limit",
        "Community workouts only",
        "Basic progress charts"
      ],
      limits: {
        workoutsPerWeek: 3,
        customWorkouts: 0,
        aiFeatures: false
      }
    },
    
    solo: {
      price: 14.99,
      name: "Solo Athlete",
      features: [
        "Unlimited workout tracking",
        "AI workout generation (10/month)",
        "Form analysis (20/month)",
        "Nutrition tracking",
        "Progress analytics",
        "No trainer required"
      ],
      limits: {
        aiWorkoutsPerMonth: 10,
        formAnalysisPerMonth: 20
      }
    },
    
    premium: {
      price: 29.99,
      name: "Premium Solo",
      features: [
        "Everything in Solo",
        "Unlimited AI features",
        "Advanced analytics",
        "Priority support",
        "Export data"
      ],
      limits: {
        unlimited: true
      }
    }
  },

  // 2. SPECIALIST/TRAINER TIERS (B2B)
  specialist: {
    starter: {
      price: 49.99,
      name: "Trainer Starter",
      clientSlots: 10,
      pricePerExtraClient: 2.50,
      features: [
        "Client management dashboard",
        "Custom workout builder",
        "Progress tracking for all clients",
        "Basic branding",
        "Payment processing",
        "Client mobile app"
      ],
      commission: 0.10 // 10% on client payments
    },
    
    professional: {
      price: 99.99,
      name: "Trainer Pro",
      clientSlots: 50,
      pricePerExtraClient: 2.00,
      features: [
        "Everything in Starter",
        "White-label mobile app",
        "Advanced analytics",
        "Group training sessions",
        "Automated billing",
        "Custom intake forms"
      ],
      commission: 0.07 // 7% on client payments
    },
    
    master: {
      price: 249.99,
      name: "Master Trainer",
      clientSlots: 200,
      pricePerExtraClient: 1.50,
      features: [
        "Everything in Pro",
        "Multiple trainer accounts",
        "API access",
        "Priority support",
        "Custom integrations",
        "Advanced automation"
      ],
      commission: 0.05 // 5% on client payments
    }
  },

  // 3. GYM TIERS
  gym: {
    small: {
      price: 299.99,
      name: "Gym Starter",
      memberSlots: 100,
      trainerAccounts: 5,
      pricePerExtraMember: 1.00,
      features: [
        "Gym management dashboard",
        "Member check-in system",
        "Class scheduling",
        "Equipment tracking",
        "Basic reporting",
        "Trainer management"
      ]
    },
    
    standard: {
      price: 599.99,
      name: "Gym Standard",
      memberSlots: 500,
      trainerAccounts: 20,
      pricePerExtraMember: 0.75,
      features: [
        "Everything in Starter",
        "Advanced analytics",
        "Member app with gym branding",
        "Automated billing",
        "Equipment maintenance tracking",
        "Challenge & competition tools"
      ]
    },
    
    premium: {
      price: 999.99,
      name: "Gym Premium",
      memberSlots: 1000,
      trainerAccounts: 50,
      pricePerExtraMember: 0.50,
      features: [
        "Everything in Standard",
        "Multiple location support",
        "Franchise management",
        "Custom mobile apps",
        "API access",
        "Dedicated support"
      ]
    }
  },

  // 4. ENTERPRISE TIER
  enterprise: {
    custom: {
      basePrice: 2499.99,
      name: "Enterprise",
      features: [
        "Unlimited everything",
        "Custom development",
        "Dedicated infrastructure",
        "SLA guarantees",
        "On-premise option",
        "Dedicated success manager",
        "Custom AI model training"
      ],
      customPricing: true
    }
  }
};

// ==========================================
// AUTOMATED TIER MANAGEMENT SYSTEM
// ==========================================

class TierAutomationSystem {
  constructor(db, stripe, analyticsEngine) {
    this.db = db;
    this.stripe = stripe;
    this.analytics = analyticsEngine;
  }

  // 1. AUTO-UPGRADE DETECTION
  async checkForAutoUpgrade(accountId) {
    const account = await this.getAccount(accountId);
    const usage = await this.getUsageMetrics(accountId);
    
    // Check if they're exceeding limits
    if (account.type === 'specialist') {
      const currentTier = tierStructure.specialist[account.tier];
      
      if (usage.activeClients > currentTier.clientSlots) {
        // Auto-upgrade or charge overage
        return {
          action: 'UPGRADE_NEEDED',
          reason: 'client_limit_exceeded',
          currentClients: usage.activeClients,
          limit: currentTier.clientSlots,
          suggestedTier: this.getNextTier(account),
          overageCharge: (usage.activeClients - currentTier.clientSlots) * currentTier.pricePerExtraClient
        };
      }
    }
    
    // Similar checks for gym accounts
    if (account.type === 'gym') {
      const currentTier = tierStructure.gym[account.tier];
      
      if (usage.activeMembers > currentTier.memberSlots || 
          usage.activeTrainers > currentTier.trainerAccounts) {
        return {
          action: 'UPGRADE_NEEDED',
          reason: 'limit_exceeded',
          suggestedTier: this.getNextTier(account)
        };
      }
    }
    
    return { action: 'NO_ACTION' };
  }

  // 2. CLIENT ASSIGNMENT AUTOMATION
  async assignClientToTrainer(clientId, trainerId) {
    const trainer = await this.getAccount(trainerId);
    const trainerUsage = await this.getUsageMetrics(trainerId);
    
    // Check if trainer has available slots
    const tier = tierStructure.specialist[trainer.tier];
    const availableSlots = tier.clientSlots - trainerUsage.activeClients;
    
    if (availableSlots <= 0) {
      // Check if auto-billing for extra clients is enabled
      if (trainer.settings.autoChargeForExtraClients) {
        // Add to overage
        await this.db.query(`
          INSERT INTO trainer_client_relationships 
          (trainer_id, client_id, is_overage, overage_rate)
          VALUES ($1, $2, true, $3)
        `, [trainerId, clientId, tier.pricePerExtraClient]);
        
        // Schedule overage charge
        await this.scheduleOverageCharge(trainerId, tier.pricePerExtraClient);
        
        return { success: true, overage: true };
      } else {
        // Prompt for upgrade
        await this.notifyUpgradeNeeded(trainerId);
        return { success: false, reason: 'SLOTS_FULL' };
      }
    }
    
    // Assign normally
    await this.db.query(`
      INSERT INTO trainer_client_relationships 
      (trainer_id, client_id, assigned_at)
      VALUES ($1, $2, NOW())
    `, [trainerId, clientId]);
    
    return { success: true, overage: false };
  }

  // 3. BILLING AUTOMATION
  async processBilling() {
    // Process all account types
    const accounts = await this.getAllActiveAccounts();
    
    for (const account of accounts) {
      try {
        await this.processAccountBilling(account);
      } catch (error) {
        await this.handleBillingError(account, error);
      }
    }
  }

  async processAccountBilling(account) {
    const usage = await this.getUsageMetrics(account.id);
    let totalCharge = 0;
    
    switch (account.type) {
      case 'individual':
        // Simple flat rate
        totalCharge = tierStructure.individual[account.tier].price;
        break;
        
      case 'specialist':
        const specialistTier = tierStructure.specialist[account.tier];
        totalCharge = specialistTier.price;
        
        // Add overage charges
        if (usage.activeClients > specialistTier.clientSlots) {
          const overage = usage.activeClients - specialistTier.clientSlots;
          totalCharge += overage * specialistTier.pricePerExtraClient;
        }
        
        // Process commission on client payments
        const clientRevenue = await this.getClientRevenue(account.id);
        const commission = clientRevenue * specialistTier.commission;
        totalCharge += commission;
        break;
        
      case 'gym':
        const gymTier = tierStructure.gym[account.tier];
        totalCharge = gymTier.price;
        
        // Add member overage
        if (usage.activeMembers > gymTier.memberSlots) {
          const overage = usage.activeMembers - gymTier.memberSlots;
          totalCharge += overage * gymTier.pricePerExtraMember;
        }
        break;
        
      case 'enterprise':
        // Custom billing logic
        totalCharge = await this.calculateEnterpriseCharge(account);
        break;
    }
    
    // Process the charge
    await this.stripe.charges.create({
      amount: Math.round(totalCharge * 100), // Convert to cents
      currency: 'usd',
      customer: account.stripeCustomerId,
      description: `Clockwork ${account.tier} - ${new Date().toLocaleDateString()}`
    });
    
    // Record billing
    await this.recordBilling(account.id, totalCharge, usage);
  }

  // 4. ACCESS CONTROL AUTOMATION
  async checkFeatureAccess(userId, feature) {
    const user = await this.getUser(userId);
    const account = await this.getAccount(user.accountId);
    
    // Individual users
    if (user.type === 'individual') {
      const tier = tierStructure.individual[account.tier];
      return this.checkIndividualAccess(tier, feature, user);
    }
    
    // Clients of trainers/gyms
    if (user.type === 'client') {
      const parentAccount = await this.getParentAccount(user.id);
      return this.checkClientAccess(parentAccount, feature, user);
    }
    
    // Trainers
    if (user.type === 'trainer') {
      const tier = tierStructure.specialist[account.tier];
      return this.checkTrainerAccess(tier, feature, user);
    }
    
    return false;
  }

  // 5. AUTOMATED TIER MIGRATION
  async migrateAccount(accountId, newType, newTier) {
    const account = await this.getAccount(accountId);
    
    // Handle data migration
    if (account.type === 'individual' && newType === 'specialist') {
      // Convert individual to trainer
      await this.convertToTrainer(accountId);
    } else if (account.type === 'specialist' && newType === 'gym') {
      // Convert trainer to gym
      await this.convertToGym(accountId);
    }
    
    // Update billing
    await this.updateBillingPlan(accountId, newType, newTier);
    
    // Migrate features and data
    await this.migrateFeatures(accountId, account.type, newType, account.tier, newTier);
    
    // Notify user
    await this.notifyTierChange(accountId, newType, newTier);
  }

  // 6. AUTOMATED ONBOARDING FLOWS
  async automatedOnboarding(accountType, accountData) {
    switch (accountType) {
      case 'individual':
        return this.onboardIndividual(accountData);
        
      case 'specialist':
        return this.onboardSpecialist(accountData);
        
      case 'gym':
        return this.onboardGym(accountData);
        
      case 'enterprise':
        return this.onboardEnterprise(accountData);
    }
  }

  async onboardSpecialist(data) {
    // 1. Create trainer account
    const accountId = await this.createAccount({
      type: 'specialist',
      tier: 'starter',
      ...data
    });
    
    // 2. Setup payment processing
    const stripeAccount = await this.stripe.accounts.create({
      type: 'express',
      country: data.country || 'US',
      email: data.email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true }
      }
    });
    
    // 3. Generate branded client portal
    await this.generateClientPortal(accountId, data.brandingPreferences);
    
    // 4. Setup automation rules
    await this.setupDefaultAutomations(accountId, 'specialist');
    
    // 5. Send onboarding sequence
    await this.sendOnboardingEmails(accountId, 'specialist');
    
    return { accountId, stripeAccountId: stripeAccount.id };
  }
}

// ==========================================
// DATABASE SCHEMA FOR MULTI-TIER SYSTEM
// ==========================================

const dbSchema = `
-- Account Types and Tiers
CREATE TABLE accounts (
  id UUID PRIMARY KEY,
  type ENUM('individual', 'specialist', 'gym', 'enterprise'),
  tier VARCHAR(50),
  parent_account_id UUID REFERENCES accounts(id),
  stripe_customer_id VARCHAR(255),
  stripe_connect_account_id VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW(),
  upgraded_at TIMESTAMP,
  status ENUM('active', 'suspended', 'cancelled')
);

-- Usage Tracking
CREATE TABLE usage_metrics (
  account_id UUID REFERENCES accounts(id),
  metric_date DATE,
  active_clients INTEGER DEFAULT 0,
  active_members INTEGER DEFAULT 0,
  active_trainers INTEGER DEFAULT 0,
  ai_workouts_generated INTEGER DEFAULT 0,
  form_analyses_performed INTEGER DEFAULT 0,
  storage_used_mb INTEGER DEFAULT 0,
  api_calls INTEGER DEFAULT 0,
  PRIMARY KEY (account_id, metric_date)
);

-- Relationship Management
CREATE TABLE relationships (
  id UUID PRIMARY KEY,
  parent_account_id UUID REFERENCES accounts(id),
  child_account_id UUID REFERENCES accounts(id),
  relationship_type ENUM('trainer_client', 'gym_member', 'gym_trainer'),
  is_overage BOOLEAN DEFAULT FALSE,
  overage_rate DECIMAL(10,2),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Feature Access Control
CREATE TABLE feature_access (
  account_type VARCHAR(50),
  tier VARCHAR(50),
  feature_key VARCHAR(100),
  access_level ENUM('none', 'limited', 'full'),
  limit_value INTEGER,
  PRIMARY KEY (account_type, tier, feature_key)
);

-- Billing History
CREATE TABLE billing_history (
  id UUID PRIMARY KEY,
  account_id UUID REFERENCES accounts(id),
  amount DECIMAL(10,2),
  base_charge DECIMAL(10,2),
  overage_charge DECIMAL(10,2),
  commission_charge DECIMAL(10,2),
  billing_period_start DATE,
  billing_period_end DATE,
  created_at TIMESTAMP DEFAULT NOW()
);
`;

// ==========================================
// IMPLEMENTATION EXAMPLE
// ==========================================

// Initialize the system
const tierSystem = new TierAutomationSystem(db, stripe, analytics);

// Example: Trainer signs up a new client
async function handleClientSignup(trainerId, clientData) {
  // 1. Create client account
  const client = await createClientAccount(clientData);
  
  // 2. Auto-assign to trainer (handles billing)
  const assignment = await tierSystem.assignClientToTrainer(client.id, trainerId);
  
  if (!assignment.success) {
    // Prompt trainer to upgrade
    return {
      error: 'Trainer has reached client limit',
      upgradeUrl: `/upgrade?from=${trainer.tier}&reason=client_limit`
    };
  }
  
  // 3. Setup client access
  await setupClientAccess(client.id, trainerId);
  
  // 4. Send welcome emails
  await sendClientWelcome(client, trainer);
  
  return { success: true, clientId: client.id };
}

// Example: Automated daily billing
async function runDailyBilling() {
  console.log('Starting automated billing run...');
  
  // Process all accounts
  await tierSystem.processBilling();
  
  // Check for needed upgrades
  const accounts = await getAllActiveAccounts();
  for (const account of accounts) {
    const upgradeCheck = await tierSystem.checkForAutoUpgrade(account.id);
    if (upgradeCheck.action === 'UPGRADE_NEEDED') {
      await notifyAccountUpgradeNeeded(account, upgradeCheck);
    }
  }
  
  console.log('Billing run complete');
}

// Schedule daily billing
cron.schedule('0 2 * * *', runDailyBilling); // Run at 2 AM daily