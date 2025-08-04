// server.js - Updated with billing integration
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
require('dotenv').config();

const app = express();

// Import database
const db = require('./config/database');

// Import middleware
const { authenticateToken } = require('./middleware/auth');
const { 
  enforceRestrictions, 
  checkClientLimits, 
  trackUsage, 
  addBillingHeaders,
  handleStripeWebhook 
} = require('./middleware/billingRestrictions');

// Import scheduled tasks
const scheduledTasksRunner = require('./services/scheduledTasks');

// Security middleware
app.use(helmet());
app.use(compression());

// CORS configuration
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  credentials: true,
  exposedHeaders: ['X-Billing-Tier', 'X-Client-Count', 'X-Client-Limit', 'X-Account-Restricted']
}));

// Logging
app.use(morgan(process.env.LOG_FORMAT || 'combined'));

// IMPORTANT: Raw body for Stripe webhooks MUST come before express.json()
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Health check endpoint (no auth required)
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV
  });
});

// Public billing endpoints (no auth required)
app.get('/api/billing/tiers', require('./routes/billing').getTiers);

// Apply authentication middleware to all other routes
app.use('/api', authenticateToken);

// Apply billing middleware after authentication
app.use('/api', trackUsage);
app.use('/api', addBillingHeaders);

// Import routes
const authRoutes = require('./routes/auth');
const clientRoutes = require('./routes/clients');
const measurementRoutes = require('./routes/measurements');
const workoutRoutes = require('./routes/workouts');
const nutritionRoutes = require('./routes/nutrition');
const goalRoutes = require('./routes/goals');
const testRoutes = require('./routes/tests');
const billingRoutes = require('./routes/billing');
const chatRoutes = require('./routes/chat');
const reportRoutes = require('./routes/reports');

// Apply routes
app.use('/api/auth', authRoutes);

// Apply billing restrictions to client routes
app.use('/api/clients', checkClientLimits, enforceRestrictions, clientRoutes);

// Other routes with standard middleware
app.use('/api/measurements', measurementRoutes);
app.use('/api/workouts', workoutRoutes);
app.use('/api/nutrition', nutritionRoutes);
app.use('/api/goals', goalRoutes);
app.use('/api/tests', testRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/reports', reportRoutes);

// Global error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  
  // Handle Stripe errors
  if (err.type === 'StripeCardError') {
    return res.status(400).json({
      error: 'Card error',
      message: err.message
    });
  }
  
  // Handle validation errors
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      error: 'Validation error',
      details: err.details
    });
  }
  
  // Handle database errors
  if (err.code && err.code.startsWith('23')) {
    return res.status(400).json({
      error: 'Database constraint violation',
      message: 'The operation violates database constraints'
    });
  }
  
  // Default error
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Start server
const PORT = process.env.PORT || 3001;

async function startServer() {
  try {
    // Test database connection
    await db.query('SELECT NOW()');
    console.log('Database connection verified');
    
    // Start scheduled tasks
    if (process.env.ENABLE_BILLING === 'true') {
      scheduledTasksRunner.start();
      console.log('Scheduled tasks started');
    }
    
    // Start server
    const server = app.listen(PORT, () => {
      console.log(`
🚀 ClockWork Backend Server Started
===================================
Environment: ${process.env.NODE_ENV}
Port: ${PORT}
Database: Connected
Billing: ${process.env.ENABLE_BILLING === 'true' ? 'Enabled' : 'Disabled'}
API URL: http://localhost:${PORT}
===================================
      `);
    });
    
    // Graceful shutdown
    const gracefulShutdown = async (signal) => {
      console.log(`\n${signal} received. Starting graceful shutdown...`);
      
      // Stop accepting new connections
      server.close(() => {
        console.log('HTTP server closed');
      });
      
      // Stop scheduled tasks
      scheduledTasksRunner.stop();
      
      // Close database connections
      await db.close();
      
      // Exit
      process.exit(0);
    };
    
    // Handle shutdown signals
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Start the server
startServer();