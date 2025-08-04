# .env.example - Copy to .env and fill in your values

# Database Configuration
DB_HOST=localhost
DB_PORT=5432
DB_NAME=clockwork_db
DB_USER=postgres
DB_PASSWORD=your_secure_password

# Server Configuration
PORT=3001
NODE_ENV=development
SESSION_SECRET=your_random_session_secret_here

# JWT Configuration
JWT_SECRET=your_jwt_secret_key_here
JWT_EXPIRES_IN=7d

# Stripe Configuration
STRIPE_SECRET_KEY=sk_test_your_stripe_secret_key
STRIPE_PUBLISHABLE_KEY=pk_test_your_stripe_publishable_key
STRIPE_WEBHOOK_SECRET=whsec_your_webhook_secret

# Stripe Price IDs (create these in Stripe Dashboard)
STRIPE_PRICE_STARTER=price_1234567890starter
STRIPE_PRICE_PROFESSIONAL=price_1234567890professional
STRIPE_PRICE_SCALE=price_1234567890scale
STRIPE_PRICE_ENTERPRISE=price_1234567890enterprise

# Email Configuration (Gmail example)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-specific-password
SMTP_FROM=noreply@clockwork.com

# Application URLs
APP_URL=http://localhost:3000
API_URL=http://localhost:3001

# Redis Configuration (optional, for scaling)
REDIS_URL=redis://localhost:6379

# Sentry Configuration (optional, for error tracking)
SENTRY_DSN=your_sentry_dsn_here

# Analytics (optional)
GOOGLE_ANALYTICS_ID=UA-XXXXXXXXX-X
MIXPANEL_TOKEN=your_mixpanel_token

# File Storage (optional, for profile pictures, etc)
AWS_ACCESS_KEY_ID=your_aws_key
AWS_SECRET_ACCESS_KEY=your_aws_secret
AWS_S3_BUCKET=clockwork-uploads
AWS_REGION=us-east-1

# Feature Flags
ENABLE_BILLING=true
ENABLE_SMART_ARCHIVE=true
ENABLE_USAGE_TRACKING=true
TRIAL_DAYS=14
GRACE_PERIOD_DAYS=7

# Logging
LOG_LEVEL=info
LOG_FORMAT=json

# Security
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100
CORS_ORIGIN=http://localhost:3000

# Monitoring
HEALTH_CHECK_PATH=/health
METRICS_PATH=/metrics