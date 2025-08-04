// scripts/migrate.js
const fs = require('fs');
const path = require('path');
const db = require('../config/database');

// Create migrations table if it doesn't exist
async function createMigrationsTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) UNIQUE NOT NULL,
      executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

// Get list of executed migrations
async function getExecutedMigrations() {
  const result = await db.query('SELECT filename FROM migrations ORDER BY id');
  return result.rows.map(row => row.filename);
}

// Execute a migration file
async function executeMigration(filepath, filename) {
  console.log(`Executing migration: ${filename}`);
  
  const sql = fs.readFileSync(filepath, 'utf8');
  
  try {
    await db.transaction(async (client) => {
      // Execute the migration SQL
      await client.query(sql);
      
      // Record the migration
      await client.query(
        'INSERT INTO migrations (filename) VALUES ($1)',
        [filename]
      );
    });
    
    console.log(`✓ Migration completed: ${filename}`);
  } catch (error) {
    console.error(`✗ Migration failed: ${filename}`);
    console.error(error.message);
    throw error;
  }
}

// Run all pending migrations
async function runMigrations() {
  try {
    console.log('Starting database migrations...\n');
    
    // Ensure migrations table exists
    await createMigrationsTable();
    
    // Get list of executed migrations
    const executedMigrations = await getExecutedMigrations();
    console.log(`Found ${executedMigrations.length} executed migrations\n`);
    
    // Get all migration files
    const migrationsDir = path.join(__dirname, '..', 'migrations');
    
    // Create migrations directory if it doesn't exist
    if (!fs.existsSync(migrationsDir)) {
      fs.mkdirSync(migrationsDir, { recursive: true });
      console.log('Created migrations directory');
    }
    
    const migrationFiles = fs.readdirSync(migrationsDir)
      .filter(file => file.endsWith('.sql'))
      .sort(); // Ensure migrations run in order
    
    // Find pending migrations
    const pendingMigrations = migrationFiles.filter(
      file => !executedMigrations.includes(file)
    );
    
    if (pendingMigrations.length === 0) {
      console.log('No pending migrations found.');
      return;
    }
    
    console.log(`Found ${pendingMigrations.length} pending migrations:\n`);
    pendingMigrations.forEach(m => console.log(`  - ${m}`));
    console.log('');
    
    // Execute pending migrations
    for (const migration of pendingMigrations) {
      const filepath = path.join(migrationsDir, migration);
      await executeMigration(filepath, migration);
    }
    
    console.log('\n✅ All migrations completed successfully!');
    
  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    process.exit(1);
  } finally {
    await db.close();
  }
}

// Rollback last migration (optional)
async function rollbackMigration() {
  try {
    const result = await db.query(
      'SELECT filename FROM migrations ORDER BY id DESC LIMIT 1'
    );
    
    if (result.rows.length === 0) {
      console.log('No migrations to rollback');
      return;
    }
    
    const lastMigration = result.rows[0].filename;
    console.log(`Rolling back migration: ${lastMigration}`);
    
    // Look for down migration file
    const downFile = lastMigration.replace('.sql', '.down.sql');
    const downPath = path.join(__dirname, '..', 'migrations', downFile);
    
    if (!fs.existsSync(downPath)) {
      console.error(`Down migration not found: ${downFile}`);
      console.error('Please manually rollback the changes');
      return;
    }
    
    const sql = fs.readFileSync(downPath, 'utf8');
    
    await db.transaction(async (client) => {
      // Execute rollback
      await client.query(sql);
      
      // Remove migration record
      await client.query(
        'DELETE FROM migrations WHERE filename = $1',
        [lastMigration]
      );
    });
    
    console.log(`✓ Rollback completed: ${lastMigration}`);
    
  } catch (error) {
    console.error('Rollback failed:', error.message);
    process.exit(1);
  } finally {
    await db.close();
  }
}

// Check command line arguments
const command = process.argv[2];

if (command === 'down') {
  rollbackMigration();
} else {
  runMigrations();
}

// Export for testing
module.exports = { runMigrations, rollbackMigration };