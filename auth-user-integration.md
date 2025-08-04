# Authentication & User Management Integration Plan

## Step 1: Database Schema

### 1.1 Create Database Migration
Create a new migration file for users and relationships:

```sql
-- clockwork-backend/migrations/001_users_and_relationships.sql

-- Users table with multi-role support
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    is_active BOOLEAN DEFAULT true,
    email_verified BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Roles table
CREATE TABLE roles (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL,
    description TEXT
);

-- Insert default roles
INSERT INTO roles (name, description) VALUES
    ('client', 'Regular client user'),
    ('specialist', 'Specialist/Trainer who can manage clients'),
    ('admin', 'Administrator with elevated privileges'),
    ('owner', 'Business owner with full access'),
    ('engineer', 'Technical administrator');

-- User roles junction table (many-to-many)
CREATE TABLE user_roles (
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
    assigned_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    assigned_by UUID REFERENCES users(id),
    PRIMARY KEY (user_id, role_id)
);

-- User permissions table
CREATE TABLE user_permissions (
    id SERIAL PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    billing_enabled BOOLEAN DEFAULT false,
    can_train_clients BOOLEAN DEFAULT false,
    can_assign_billing BOOLEAN DEFAULT false,
    max_clients INTEGER DEFAULT 0,
    subscription_plan VARCHAR(50) DEFAULT 'basic',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Client-Specialist relationships
CREATE TABLE client_specialist_relationships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID REFERENCES users(id) ON DELETE CASCADE,
    specialist_id UUID REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(50) DEFAULT 'active', -- active, paused, terminated
    assigned_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    assigned_by UUID REFERENCES users(id),
    notes TEXT,
    UNIQUE(client_id, specialist_id)
);

-- Session tokens for JWT refresh
CREATE TABLE refresh_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(500) UNIQUE NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    revoked_at TIMESTAMP WITH TIME ZONE
);

-- Indexes for performance
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_user_roles_user_id ON user_roles(user_id);
CREATE INDEX idx_relationships_client ON client_specialist_relationships(client_id);
CREATE INDEX idx_relationships_specialist ON client_specialist_relationships(specialist_id);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_token ON refresh_tokens(token);
```

### 1.2 Run the Migration
```bash
# Create a migration script
cd clockwork-backend
node -e "
const { Pool } = require('pg');
const fs = require('fs');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function migrate() {
  try {
    const sql = fs.readFileSync('./migrations/001_users_and_relationships.sql', 'utf8');
    await pool.query(sql);
    console.log('Migration completed successfully');
  } catch (error) {
    console.error('Migration failed:', error);
  } finally {
    await pool.end();
  }
}

migrate();
"
```

## Step 2: Backend Implementation

### 2.1 User Model
Create a user model with database operations:

```javascript
// clockwork-backend/models/user.model.js
const db = require('../clockwork-database-config');
const bcrypt = require('bcryptjs');

class UserModel {
  static async create(userData) {
    const { email, password, name, phone, roles = ['client'] } = userData;
    
    // Start transaction
    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');
      
      // Hash password
      const passwordHash = await bcrypt.hash(password, 10);
      
      // Insert user
      const userResult = await client.query(
        `INSERT INTO users (email, password_hash, name, phone) 
         VALUES ($1, $2, $3, $4) 
         RETURNING id, email, name, phone, created_at`,
        [email, passwordHash, name, phone]
      );
      
      const user = userResult.rows[0];
      
      // Insert roles
      for (const roleName of roles) {
        const roleResult = await client.query(
          'SELECT id FROM roles WHERE name = $1',
          [roleName]
        );
        
        if (roleResult.rows.length > 0) {
          await client.query(
            'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)',
            [user.id, roleResult.rows[0].id]
          );
        }
      }
      
      // Create user permissions
      await client.query(
        'INSERT INTO user_permissions (user_id) VALUES ($1)',
        [user.id]
      );
      
      await client.query('COMMIT');
      
      // Fetch complete user with roles
      return await this.findById(user.id);
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  
  static async findByEmail(email) {
    const result = await db.query(
      `SELECT u.*, 
              array_agg(DISTINCT r.name) as roles,
              up.billing_enabled,
              up.can_train_clients,
              up.subscription_plan
       FROM users u
       LEFT JOIN user_roles ur ON u.id = ur.user_id
       LEFT JOIN roles r ON ur.role_id = r.id
       LEFT JOIN user_permissions up ON u.id = up.user_id
       WHERE u.email = $1 AND u.is_active = true
       GROUP BY u.id, up.billing_enabled, up.can_train_clients, up.subscription_plan`,
      [email]
    );
    
    return result.rows[0];
  }
  
  static async findById(id) {
    const result = await db.query(
      `SELECT u.*, 
              array_agg(DISTINCT r.name) as roles,
              up.billing_enabled,
              up.can_train_clients,
              up.subscription_plan,
              array_agg(DISTINCT csr.specialist_id) FILTER (WHERE csr.specialist_id IS NOT NULL) as specialist_ids,
              array_agg(DISTINCT csr2.client_id) FILTER (WHERE csr2.client_id IS NOT NULL) as client_ids
       FROM users u
       LEFT JOIN user_roles ur ON u.id = ur.user_id
       LEFT JOIN roles r ON ur.role_id = r.id
       LEFT JOIN user_permissions up ON u.id = up.user_id
       LEFT JOIN client_specialist_relationships csr ON u.id = csr.client_id AND csr.status = 'active'
       LEFT JOIN client_specialist_relationships csr2 ON u.id = csr2.specialist_id AND csr2.status = 'active'
       WHERE u.id = $1 AND u.is_active = true
       GROUP BY u.id, up.billing_enabled, up.can_train_clients, up.subscription_plan`,
      [id]
    );
    
    return result.rows[0];
  }
  
  static async validatePassword(password, passwordHash) {
    return bcrypt.compare(password, passwordHash);
  }
  
  static async getAllUsers(currentUserId, userRole) {
    let query = `
      SELECT u.id, u.email, u.name, u.phone, u.created_at,
             array_agg(DISTINCT r.name) as roles,
             up.billing_enabled,
             up.can_train_clients,
             up.subscription_plan
      FROM users u
      LEFT JOIN user_roles ur ON u.id = ur.user_id
      LEFT JOIN roles r ON ur.role_id = r.id
      LEFT JOIN user_permissions up ON u.id = up.user_id
      WHERE u.is_active = true
    `;
    
    // Role-based filtering
    if (userRole.includes('specialist') && !userRole.includes('admin') && !userRole.includes('owner')) {
      query += ` AND (
        u.id IN (
          SELECT client_id FROM client_specialist_relationships 
          WHERE specialist_id = $1 AND status = 'active'
        )
        OR u.id = $1
      )`;
    }
    
    query += ` GROUP BY u.id, up.billing_enabled, up.can_train_clients, up.subscription_plan
               ORDER BY u.created_at DESC`;
    
    const params = userRole.includes('specialist') && !userRole.includes('admin') ? [currentUserId] : [];
    const result = await db.query(query, params);
    
    return result.rows;
  }
  
  static async getMyClients(specialistId) {
    const result = await db.query(
      `SELECT u.*, 
              array_agg(DISTINCT r.name) as roles,
              csr.assigned_at,
              csr.notes
       FROM users u
       INNER JOIN client_specialist_relationships csr ON u.id = csr.client_id
       LEFT JOIN user_roles ur ON u.id = ur.user_id
       LEFT JOIN roles r ON ur.role_id = r.id
       WHERE csr.specialist_id = $1 AND csr.status = 'active' AND u.is_active = true
       GROUP BY u.id, csr.assigned_at, csr.notes
       ORDER BY csr.assigned_at DESC`,
      [specialistId]
    );
    
    return result.rows;
  }
  
  static async assignClientToSpecialist(clientId, specialistId, assignedBy) {
    try {
      await db.query(
        `INSERT INTO client_specialist_relationships (client_id, specialist_id, assigned_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (client_id, specialist_id) 
         DO UPDATE SET status = 'active', assigned_at = CURRENT_TIMESTAMP`,
        [clientId, specialistId, assignedBy]
      );
      
      return { success: true };
    } catch (error) {
      throw error;
    }
  }
  
  static async updateUserRoles(userId, roles, updatedBy) {
    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');
      
      // Remove existing roles
      await client.query(
        'DELETE FROM user_roles WHERE user_id = $1',
        [userId]
      );
      
      // Add new roles
      for (const roleName of roles) {
        const roleResult = await client.query(
          'SELECT id FROM roles WHERE name = $1',
          [roleName]
        );
        
        if (roleResult.rows.length > 0) {
          await client.query(
            'INSERT INTO user_roles (user_id, role_id, assigned_by) VALUES ($1, $2, $3)',
            [userId, roleResult.rows[0].id, updatedBy]
          );
        }
      }
      
      await client.query('COMMIT');
      return { success: true };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = UserModel;
```

### 2.2 Authentication Controller
Update the auth controller with real implementation:

```javascript
// clockwork-backend/clockwork-auth-controller.js
const jwt = require('jsonwebtoken');
const UserModel = require('./models/user.model');
const db = require('./clockwork-database-config');
const { v4: uuidv4 } = require('uuid');

class AuthController {
  static async signup(req, res) {
    try {
      const { email, password, name, phone } = req.body;
      
      // Check if user exists
      const existingUser = await UserModel.findByEmail(email);
      if (existingUser) {
        return res.status(400).json({ 
          error: 'Email already exists' 
        });
      }
      
      // Create user with default client role
      const user = await UserModel.create({
        email,
        password,
        name,
        phone,
        roles: ['client']
      });
      
      // Generate tokens
      const token = jwt.sign(
        { userId: user.id, email: user.email, roles: user.roles },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
      );
      
      const refreshToken = jwt.sign(
        { userId: user.id, type: 'refresh' },
        process.env.JWT_REFRESH_SECRET,
        { expiresIn: '7d' }
      );
      
      // Store refresh token
      await db.query(
        `INSERT INTO refresh_tokens (user_id, token, expires_at) 
         VALUES ($1, $2, $3)`,
        [user.id, refreshToken, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)]
      );
      
      res.json({
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          phone: user.phone,
          roles: user.roles,
          billingEnabled: user.billing_enabled,
          canTrainClients: user.can_train_clients,
          subscriptionPlan: user.subscription_plan
        },
        token,
        refreshToken
      });
      
    } catch (error) {
      console.error('Signup error:', error);
      res.status(500).json({ error: 'Failed to create account' });
    }
  }
  
  static async login(req, res) {
    try {
      const { email, password } = req.body;
      
      // Find user
      const user = await UserModel.findByEmail(email);
      if (!user) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      
      // Validate password
      const isValid = await UserModel.validatePassword(password, user.password_hash);
      if (!isValid) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      
      // Get full user data with relationships
      const fullUser = await UserModel.findById(user.id);
      
      // Generate tokens
      const token = jwt.sign(
        { userId: user.id, email: user.email, roles: user.roles },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
      );
      
      const refreshToken = jwt.sign(
        { userId: user.id, type: 'refresh' },
        process.env.JWT_REFRESH_SECRET,
        { expiresIn: '7d' }
      );
      
      // Store refresh token
      await db.query(
        `INSERT INTO refresh_tokens (user_id, token, expires_at) 
         VALUES ($1, $2, $3)`,
        [user.id, refreshToken, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)]
      );
      
      res.json({
        user: {
          id: fullUser.id,
          email: fullUser.email,
          name: fullUser.name,
          phone: fullUser.phone,
          roles: fullUser.roles,
          billingEnabled: fullUser.billing_enabled,
          canTrainClients: fullUser.can_train_clients,
          subscriptionPlan: fullUser.subscription_plan,
          specialistIds: fullUser.specialist_ids || [],
          clientIds: fullUser.client_ids || []
        },
        token,
        refreshToken
      });
      
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ error: 'Login failed' });
    }
  }
  
  static async logout(req, res) {
    try {
      const userId = req.user.userId;
      
      // Revoke all refresh tokens for this user
      await db.query(
        `UPDATE refresh_tokens 
         SET revoked_at = CURRENT_TIMESTAMP 
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId]
      );
      
      res.json({ message: 'Logged out successfully' });
      
    } catch (error) {
      console.error('Logout error:', error);
      res.status(500).json({ error: 'Logout failed' });
    }
  }
  
  static async refresh(req, res) {
    try {
      const { refreshToken } = req.body;
      
      if (!refreshToken) {
        return res.status(401).json({ error: 'Refresh token required' });
      }
      
      // Verify refresh token
      const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
      
      // Check if token exists and is not revoked
      const tokenResult = await db.query(
        `SELECT * FROM refresh_tokens 
         WHERE token = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > NOW()`,
        [refreshToken, decoded.userId]
      );
      
      if (tokenResult.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid refresh token' });
      }
      
      // Get user
      const user = await UserModel.findById(decoded.userId);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      
      // Generate new access token
      const token = jwt.sign(
        { userId: user.id, email: user.email, roles: user.roles },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
      );
      
      res.json({ token });
      
    } catch (error) {
      console.error('Refresh error:', error);
      res.status(401).json({ error: 'Invalid refresh token' });
    }
  }
  
  static async getProfile(req, res) {
    try {
      const user = await UserModel.findById(req.user.userId);
      
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      
      res.json({
        id: user.id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        roles: user.roles,
        billingEnabled: user.billing_enabled,
        canTrainClients: user.can_train_clients,
        subscriptionPlan: user.subscription_plan,
        specialistIds: user.specialist_ids || [],
        clientIds: user.client_ids || []
      });
      
    } catch (error) {
      console.error('Get profile error:', error);
      res.status(500).json({ error: 'Failed to get profile' });
    }
  }
}

module.exports = AuthController;
```

### 2.3 Update Auth Routes
Connect the controller to routes:

```javascript
// clockwork-backend/routes/auth.js
const router = require('express').Router();
const AuthController = require('../clockwork-auth-controller');
const { authenticate } = require('../middleware/auth');
const { validateRequest, validationSchemas } = require('../middleware/validation');

// Public routes
router.post('/signup', validateRequest(validationSchemas.signup), AuthController.signup);
router.post('/login', validateRequest(validationSchemas.login), AuthController.login);
router.post('/refresh', AuthController.refresh);

// Protected routes
router.post('/logout', authenticate, AuthController.logout);
router.get('/profile', authenticate, AuthController.getProfile);

module.exports = router;
```

### 2.4 User Controller
Create a user controller for user management:

```javascript
// clockwork-backend/controllers/user.controller.js
const UserModel = require('../models/user.model');

class UserController {
  static async getAllUsers(req, res) {
    try {
      const users = await UserModel.getAllUsers(req.user.userId, req.user.roles);
      
      // Add online status (you can implement real-time tracking with Socket.io)
      const usersWithStatus = users.map(user => ({
        ...user,
        online: false // This would come from a real-time tracking system
      }));
      
      res.json(usersWithStatus);
    } catch (error) {
      console.error('Get users error:', error);
      res.status(500).json({ error: 'Failed to fetch users' });
    }
  }
  
  static async getMyClients(req, res) {
    try {
      const clients = await UserModel.getMyClients(req.user.userId);
      res.json(clients);
    } catch (error) {
      console.error('Get clients error:', error);
      res.status(500).json({ error: 'Failed to fetch clients' });
    }
  }
  
  static async assignClient(req, res) {
    try {
      const { clientId, specialistId } = req.body;
      
      // Check permissions
      if (!req.user.roles.includes('admin') && 
          !req.user.roles.includes('owner') && 
          req.user.userId !== specialistId) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }
      
      await UserModel.assignClientToSpecialist(
        clientId, 
        specialistId, 
        req.user.userId
      );
      
      res.json({ success: true, message: 'Client assigned successfully' });
    } catch (error) {
      console.error('Assign client error:', error);
      res.status(500).json({ error: 'Failed to assign client' });
    }
  }
  
  static async updateUserRoles(req, res) {
    try {
      const { userId } = req.params;
      const { roles } = req.body;
      
      // Only admin and owner can update roles
      if (!req.user.roles.includes('admin') && !req.user.roles.includes('owner')) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }
      
      await UserModel.updateUserRoles(userId, roles, req.user.userId);
      res.json({ success: true, message: 'Roles updated successfully' });
    } catch (error) {
      console.error('Update roles error:', error);
      res.status(500).json({ error: 'Failed to update roles' });
    }
  }
}

module.exports = UserController;
```

### 2.5 Update User Routes
```javascript
// clockwork-backend/routes/users.js
const router = require('express').Router();
const UserController = require('../controllers/user.controller');
const { authenticate, authorize } = require('../middleware/auth');

// All authenticated users can see users (filtered by role in controller)
router.get('/', authenticate, UserController.getAllUsers);

// Specialists, admin, owner can get their clients
router.get('/my-clients', 
  authenticate, 
  authorize(['specialist', 'admin', 'owner']), 
  UserController.getMyClients
);

// Assign client to specialist
router.post('/assign-client', 
  authenticate, 
  authorize(['specialist', 'admin', 'owner']), 
  UserController.assignClient
);

// Update user roles (admin/owner only)
router.put('/:userId/roles', 
  authenticate, 
  authorize(['admin', 'owner']), 
  UserController.updateUserRoles
);

module.exports = router;
```

### 2.6 Update Auth Middleware
```javascript
// clockwork-backend/middleware/auth.js
const jwt = require('jsonwebtoken');

const authenticate = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

const authorize = (allowedRoles) => {
  return (req, res, next) => {
    const userRoles = req.user.roles || [];
    const hasPermission = allowedRoles.some(role => userRoles.includes(role));
    
    if (!hasPermission) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    
    next();
  };
};

module.exports = { authenticate, authorize };
```

## Step 3: Frontend Integration

### 3.1 Update API Service
```javascript
// Clockwork-frontend/src/services/api.js
import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';

const api = axios.create({
  baseURL: `${API_URL}/api`,
  headers: {
    'Content-Type': 'application/json',
  },
  withCredentials: true
});

// Token management
api.interceptors.request.use(
  (config) => {
    const token = sessionStorage.getItem('clockworkToken');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Auto refresh token
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    
    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;
      
      try {
        const refreshToken = sessionStorage.getItem('clockworkRefreshToken');
        const response = await api.post('/auth/refresh', { refreshToken });
        
        sessionStorage.setItem('clockworkToken', response.data.token);
        originalRequest.headers.Authorization = `Bearer ${response.data.token}`;
        
        return api(originalRequest);
      } catch (refreshError) {
        // Redirect to login
        sessionStorage.clear();
        window.location.href = '/';
        return Promise.reject(refreshError);
      }
    }
    
    return Promise.reject(error);
  }
);

export default api;
```

### 3.2 Auth Service
```javascript
// Clockwork-frontend/src/services/auth.service.js
import api from './api';

const authService = {
  async login(email, password) {
    try {
      const response = await api.post('/auth/login', { email, password });
      const { user, token, refreshToken } = response.data;
      
      // Store tokens
      sessionStorage.setItem('clockworkToken', token);
      sessionStorage.setItem('clockworkRefreshToken', refreshToken);
      sessionStorage.setItem('clockworkUser', JSON.stringify(user));
      
      return { success: true, user };
    } catch (error) {
      return { 
        success: false, 
        error: error.response?.data?.error || 'Login failed' 
      };
    }
  },

  async signup(userData) {
    try {
      const response = await api.post('/auth/signup', userData);
      const { user, token, refreshToken } = response.data;
      
      // Store tokens
      sessionStorage.setItem('clockworkToken', token);
      sessionStorage.setItem('clockworkRefreshToken', refreshToken);
      sessionStorage.setItem('clockworkUser', JSON.stringify(user));
      
      return { success: true, user };
    } catch (error) {
      return { 
        success: false, 
        error: error.response?.data?.error || 'Signup failed' 
      };
    }
  },

  async logout() {
    try {
      await api.post('/auth/logout');
    } finally {
      sessionStorage.clear();
      window.location.href = '/';
    }
  },

  async getProfile() {
    try {
      const response = await api.get('/auth/profile');
      return response.data;
    } catch (error) {
      throw error;
    }
  },

  getCurrentUser() {
    const userStr = sessionStorage.getItem('clockworkUser');
    return userStr ? JSON.parse(userStr) : null;
  },

  isAuthenticated() {
    return !!sessionStorage.getItem('clockworkToken');
  }
};

export default authService;
```

### 3.3 User Service
```javascript
// Clockwork-frontend/src/services/user.service.js
import api from './api';

const userService = {
  async getAllUsers() {
    try {
      const response = await api.get('/users');
      return response.data;
    } catch (error) {
      console.error('Failed to fetch users:', error);
      return [];
    }
  },

  async getMyClients() {
    try {
      const response = await api.get('/users/my-clients');
      return response.data;
    } catch (error) {
      console.error('Failed to fetch clients:', error);
      return [];
    }
  },

  async assignClient(clientId, specialistId) {
    try {
      const response = await api.post('/users/assign-client', {
        clientId,
        specialistId
      });
      return response.data;
    } catch (error) {
      throw error;
    }
  },

  async updateUserRoles(userId, roles) {
    try {
      const response = await api.put(`/users/${userId}/roles`, { roles });
      return response.data;
    } catch (error) {
      throw error;
    }
  }
};

export default userService;
```

### 3.4 Update Your HTML Components
Now update your login component to use the API:

```javascript
// In your index.html, update the LoginForm component's handleAuth function:
const handleAuth = async (e) => {
  e.preventDefault();
  setIsLoading(true);
  setLoginError('');
  
  try {
    if (isSignup) {
      // API signup
      const response = await fetch('http://localhost:5000/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, name, phone })
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        setLoginError(data.error || 'Signup failed');
        return;
      }
      
      // Store tokens and user
      sessionStorage.setItem('clockworkToken', data.token);
      sessionStorage.setItem('clockworkRefreshToken', data.refreshToken);
      sessionStorage.setItem('clockworkUser', JSON.stringify(data.user));
      
      setCurrentUser(data.user);
      
    } else {
      // API login
      const response = await fetch('http://localhost:5000/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        setLoginError(data.error || 'Login failed');
        return;
      }
      
      // Store tokens and user
      sessionStorage.setItem('clockworkToken', data.token);
      sessionStorage.setItem('clockworkRefreshToken', data.refreshToken);
      sessionStorage.setItem('clockworkUser', JSON.stringify(data.user));
      
      setCurrentUser(data.user);
    }
  } catch (error) {
    setLoginError('Connection error. Please try again.');
    console.error('Auth error:', error);
  } finally {
    setIsLoading(false);
  }
};
```

### 3.5 Update getAllUsers to use API
```javascript
// Add this function to fetch users from API
const fetchUsers = async () => {
  try {
    const token = sessionStorage.getItem('clockworkToken');
    const response = await fetch('http://localhost:5000/api/users', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (response.ok) {
      const users = await response.json();
      setAllUsers(users);
    }
  } catch (error) {
    console.error('Failed to fetch users:', error);
  }
};

// Call it when user logs in
useEffect(() => {
  if (currentUser) {
    fetchUsers();
  }
}, [currentUser]);
```

## Testing Steps

1. **Start Backend**:
   ```bash
   cd clockwork-backend
   npm run dev
   ```

2. **Test Authentication**:
   - Open your HTML file
   - Try signing up with a new account
   - Check if login works
   - Verify tokens are stored in sessionStorage

3. **Test User Management**:
   - Login as admin/owner
   - Check if users list loads from database
   - Try assigning clients to specialists

4. **Verify Role-Based Access**:
   - Login as different user types
   - Ensure clients only see their data
   - Ensure specialists see their clients
   - Ensure admin/owner see all users

## Next Steps

Once these three components are working:
1. Implement data migration for measurements, workouts, etc.
2. Add real-time status tracking with Socket.io
3. Implement the remaining CRUD operations for other features

Would you like me to help you implement any specific part or troubleshoot any issues?