// config/database.js
const { Pool } = require('pg');

// Create connection pool
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'clockwork_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  max: 20, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  ssl: process.env.NODE_ENV === 'production' ? {
    rejectUnauthorized: false
  } : false
});

// Test connection on startup
pool.on('connect', () => {
  console.log('Database connected successfully');
});

pool.on('error', (err) => {
  console.error('Unexpected database error:', err);
  process.exit(-1);
});

// Helper functions
const db = {
  // Basic query
  async query(text, params) {
    const start = Date.now();
    try {
      const res = await pool.query(text, params);
      const duration = Date.now() - start;
      
      // Log slow queries in development
      if (process.env.NODE_ENV === 'development' && duration > 100) {
        console.log('Slow query detected:', { text, duration, rows: res.rowCount });
      }
      
      return res;
    } catch (error) {
      console.error('Database query error:', error);
      throw error;
    }
  },

  // Transaction helper
  async transaction(callback) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },

  // Batch insert helper
  async batchInsert(table, columns, values) {
    if (!values.length) return { rowCount: 0 };
    
    const placeholders = values.map((_, rowIndex) => 
      `(${columns.map((_, colIndex) => 
        `$${rowIndex * columns.length + colIndex + 1}`
      ).join(', ')})`
    ).join(', ');
    
    const flatValues = values.flat();
    const query = `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${placeholders}`;
    
    return this.query(query, flatValues);
  },

  // Get pool for advanced usage
  getPool() {
    return pool;
  },

  // Close all connections
  async close() {
    await pool.end();
    console.log('Database connections closed');
  }
};

// Initialize database tables if needed
async function initializeDatabase() {
  try {
    // Check if billing_tiers table exists
    const tableExists = await db.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'billing_tiers'
      );
    `);
    
    if (!tableExists.rows[0].exists) {
      console.log('Billing tables not found. Please run migrations.');
      console.log('Run: psql -U your_user -d clockwork_db -f migrations/001_billing_schema.sql');
    }
  } catch (error) {
    console.error('Database initialization error:', error);
  }
}

// Run initialization
initializeDatabase();

module.exports = db;