// services/scheduledTasks.js
const cron = require('node-cron');
const db = require('../config/database');
const billingService = require('./billingService');
const emailService = require('./emailService');

class ScheduledTasksRunner {
  constructor() {
    this.tasks = new Map();
  }

  start() {
    console.log('Starting scheduled tasks runner...');
    
    // Run pending tasks every 5 minutes
    this.tasks.set('pending-tasks', cron.schedule('*/5 * * * *', () => {
      this.runPendingTasks();
    }));
    
    // Check for approaching trial ends daily at 9 AM
    this.tasks.set('trial-ends', cron.schedule('0 9 * * *', () => {
      this.checkTrialEnds();
    }));
    
    // Run smart archive suggestions weekly on Mondays at 10 AM
    this.tasks.set('smart-archive', cron.schedule('0 10 * * 1', () => {
      this.runSmartArchive();
    }));
    
    // Check for overdue invoices daily at 10 AM
    this.tasks.set('overdue-invoices', cron.schedule('0 10 * * *', () => {
      this.checkOverdueInvoices();
    }));
    
    // Update usage metrics daily at midnight
    this.tasks.set('usage-metrics', cron.schedule('0 0 * * *', () => {
      this.updateUsageMetrics();
    }));
    
    // Clean up old billing events monthly
    this.tasks.set('cleanup', cron.schedule('0 0 1 * *', () => {
      this.cleanupOldEvents();
    }));
    
    console.log('Scheduled tasks runner started successfully');
  }

  stop() {
    this.tasks.forEach((task, name) => {
      task.stop();
      console.log(`Stopped task: ${name}`);
    });
    this.tasks.clear();
  }

  async runPendingTasks() {
    try {
      // Get all pending tasks that should be executed
      const tasks = await db.query(
        `SELECT * FROM scheduled_tasks 
         WHERE status = 'pending' 
         AND execute_at <= NOW() 
         ORDER BY execute_at ASC 
         LIMIT 10`
      );

      for (const task of tasks.rows) {
        await this.executeTask(task);
      }
    } catch (error) {
      console.error('Error running pending tasks:', error);
    }
  }

  async executeTask(task) {
    try {
      console.log(`Executing task ${task.id}: ${task.task_type}`);
      
      // Mark as processing
      await db.query(
        'UPDATE scheduled_tasks SET status = $1 WHERE id = $2',
        ['processing', task.id]
      );

      let result = { success: false, message: 'Unknown task type' };

      switch (task.task_type) {
        case 'archive_client':
          result = await this.archiveClient(task);
          break;
        
        case 'send_limit_warning':
          result = await this.sendLimitWarning(task);
          break;
        
        case 'retry_payment':
          result = await this.retryPayment(task);
          break;
        
        case 'downgrade_plan':
          result = await this.downgradePlan(task);
          break;
        
        case 'cancel_subscription':
          result = await this.cancelSubscription(task);
          break;
      }

      // Mark as completed
      await db.query(
        `UPDATE scheduled_tasks 
         SET status = $1, executed_at = NOW(), result = $2 
         WHERE id = $3`,
        ['completed', JSON.stringify(result), task.id]
      );

    } catch (error) {
      console.error(`Error executing task ${task.id}:`, error);
      
      // Mark as failed
      await db.query(
        `UPDATE scheduled_tasks 
         SET status = $1, executed_at = NOW(), result = $2 
         WHERE id = $3`,
        ['failed', JSON.stringify({ error: error.message }), task.id]
      );
    }
  }

  async archiveClient(task) {
    const { client_id, specialist_id } = task;
    const payload = task.payload || {};
    
    // Archive the client
    const result = await db.query(
      `UPDATE clients 
       SET is_active = false, 
           is_archived = true, 
           archived_at = NOW(),
           archived_reason = $1
       WHERE id = $2 AND specialist_id = $3
       RETURNING id, name`,
      [payload.reason || 'auto_archived_billing_limit', client_id, specialist_id]
    );
    
    if (result.rows[0]) {
      // Recheck limits after archiving
      await billingService.checkClientLimits(specialist_id);
      
      return { 
        success: true, 
        message: `Archived client: ${result.rows[0].name}` 
      };
    }
    
    return { 
      success: false, 
      message: 'Client not found or already archived' 
    };
  }

  async sendLimitWarning(task) {
    const { specialist_id } = task;
    
    const specialist = await db.query(
      'SELECT * FROM specialists WHERE id = $1',
      [specialist_id]
    );
    
    if (specialist.rows[0]) {
      await billingService.notifyApproachingLimit(
        specialist_id,
        task.payload.clientCount,
        task.payload.limit
      );
      
      return { success: true, message: 'Warning email sent' };
    }
    
    return { success: false, message: 'Specialist not found' };
  }

  async retryPayment(task) {
    const { specialist_id } = task;
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    
    try {
      const specialist = await db.query(
        'SELECT * FROM specialists WHERE id = $1',
        [specialist_id]
      );
      
      if (!specialist.rows[0]?.stripe_subscription_id) {
        return { success: false, message: 'No subscription found' };
      }
      
      // Retry the payment
      const invoice = await stripe.invoices.pay(
        task.payload.invoice_id
      );
      
      return { 
        success: true, 
        message: 'Payment retry successful',
        invoice_id: invoice.id 
      };
    } catch (error) {
      return { 
        success: false, 
        message: `Payment retry failed: ${error.message}` 
      };
    }
  }

  async checkTrialEnds() {
    try {
      // Find specialists with trials ending in 3 days
      const results = await db.query(
        `SELECT * FROM specialists 
         WHERE subscription_status = 'trialing' 
         AND trial_ends_at BETWEEN NOW() AND NOW() + INTERVAL '3 days'
         AND trial_ends_at > NOW()`
      );
      
      for (const specialist of results.rows) {
        await emailService.sendEmail({
          to: specialist.email,
          subject: 'Your ClockWork trial ends soon',
          template: 'trial-ending',
          data: {
            name: specialist.name,
            trialEndsDate: new Date(specialist.trial_ends_at).toLocaleDateString(),
            upgradeUrl: `${process.env.APP_URL}/billing/upgrade`
          }
        });
      }
      
      console.log(`Sent ${results.rows.length} trial ending notifications`);
    } catch (error) {
      console.error('Error checking trial ends:', error);
    }
  }

  async runSmartArchive() {
    try {
      // Find all restricted specialists
      const specialists = await db.query(
        `SELECT * FROM specialists 
         WHERE is_restricted = true 
         AND restriction_reason = 'client_limit_exceeded'`
      );
      
      for (const specialist of specialists.rows) {
        await billingService.smartArchiveClients(specialist.id);
      }
      
      console.log(`Processed smart archive for ${specialists.rows.length} specialists`);
    } catch (error) {
      console.error('Error running smart archive:', error);
    }
  }

  async checkOverdueInvoices() {
    try {
      // Find overdue invoices
      const invoices = await db.query(
        `SELECT i.*, s.email, s.name 
         FROM invoices i
         JOIN specialists s ON i.specialist_id = s.id
         WHERE i.status = 'pending' 
         AND i.due_date < CURRENT_DATE
         AND i.due_date >= CURRENT_DATE - INTERVAL '30 days'`
      );
      
      for (const invoice of invoices.rows) {
        // Update status to overdue
        await db.query(
          'UPDATE invoices SET status = $1 WHERE id = $2',
          ['overdue', invoice.id]
        );
        
        // Send overdue notification
        await emailService.sendEmail({
          to: invoice.email,
          subject: `Invoice ${invoice.invoice_number} is overdue`,
          template: 'invoice-overdue',
          data: {
            name: invoice.name,
            invoiceNumber: invoice.invoice_number,
            amount: invoice.amount,
            dueDate: invoice.due_date,
            payUrl: `${process.env.APP_URL}/invoices/${invoice.id}/pay`
          }
        });
      }
      
      console.log(`Marked ${invoices.rows.length} invoices as overdue`);
    } catch (error) {
      console.error('Error checking overdue invoices:', error);
    }
  }

  async updateUsageMetrics() {
    try {
      // Update daily active users
      await db.query(
        `INSERT INTO usage_tracking (specialist_id, metric_name, metric_value, period_start, period_end)
         SELECT specialist_id, 'daily_active_users', COUNT(DISTINCT client_id), CURRENT_DATE, CURRENT_DATE
         FROM activity_logs
         WHERE created_at >= CURRENT_DATE
         GROUP BY specialist_id
         ON CONFLICT (specialist_id, metric_name, period_start)
         DO UPDATE SET metric_value = EXCLUDED.metric_value`
      );
      
      // Update client growth rate
      await db.query(
        `INSERT INTO usage_tracking (specialist_id, metric_name, metric_value, period_start, period_end)
         SELECT specialist_id, 'new_clients_30d', COUNT(*), CURRENT_DATE - INTERVAL '30 days', CURRENT_DATE
         FROM clients
         WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
         GROUP BY specialist_id
         ON CONFLICT (specialist_id, metric_name, period_start)
         DO UPDATE SET metric_value = EXCLUDED.metric_value`
      );
      
      console.log('Updated usage metrics');
    } catch (error) {
      console.error('Error updating usage metrics:', error);
    }
  }

  async cleanupOldEvents() {
    try {
      // Clean up billing events older than 1 year
      const result = await db.query(
        `DELETE FROM billing_events 
         WHERE created_at < NOW() - INTERVAL '1 year'
         AND event_type NOT IN ('subscription.created', 'subscription.deleted')`
      );
      
      console.log(`Cleaned up ${result.rowCount} old billing events`);
      
      // Clean up completed scheduled tasks older than 90 days
      const taskResult = await db.query(
        `DELETE FROM scheduled_tasks 
         WHERE status = 'completed' 
         AND executed_at < NOW() - INTERVAL '90 days'`
      );
      
      console.log(`Cleaned up ${taskResult.rowCount} old scheduled tasks`);
    } catch (error) {
      console.error('Error cleaning up old events:', error);
    }
  }
}

// Create and export singleton instance
const scheduledTasksRunner = new ScheduledTasksRunner();

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing scheduled tasks');
  scheduledTasksRunner.stop();
});

module.exports = scheduledTasksRunner;