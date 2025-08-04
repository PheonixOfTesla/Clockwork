// Clockwork AI Monetization Strategy & Implementation

// 1. TIERED PRICING MODEL WITH AI FEATURES
const pricingTiers = {
  basic: {
    price: 9.99,
    name: "Basic",
    features: [
      "Manual workout logging",
      "Basic progress tracking",
      "Community access",
      "3 custom workouts/month"
    ],
    aiFeatures: [],
    limits: {
      workoutsPerMonth: 3,
      customPrograms: 1
    }
  },
  
  pro: {
    price: 24.99,
    name: "Pro",
    features: [
      "Everything in Basic",
      "Unlimited custom workouts",
      "Advanced analytics",
      "Form check videos"
    ],
    aiFeatures: [
      "AI Workout Suggestions (10/month)",
      "Basic AI Form Analysis",
      "Smart Rest Timer"
    ],
    limits: {
      aiWorkoutsPerMonth: 10,
      aiFormChecksPerMonth: 20
    }
  },
  
  elite: {
    price: 49.99,
    name: "