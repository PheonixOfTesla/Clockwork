# ClockWork Frontend-Backend Integration Guide

## Overview
This guide will help you integrate your React frontend with your Node.js/Express backend, replacing localStorage with API calls and implementing proper authentication.

## Phase 1: Environment Setup

### 1.1 Update Backend CORS Configuration
First, ensure your backend allows requests from your frontend:

```javascript
// clockwork-backend/clockwork-server-main.js
const cors = require('cors');

app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:5173', // Vite default
    'https://your-frontend-domain.com'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
```

### 1.2 Environment Variables
Create proper `.env` files:

```bash
# Clockwork-frontend/.env.development
VITE_API_URL=http://localhost:5000
VITE_SOCKET_URL=http://localhost:5000
```

```bash
# clockwork-backend/.env
PORT=5000
DATABASE_URL=postgresql://user:password@localhost:5432/clockwork
JWT_SECRET=your-secure-jwt-secret
JWT_REFRESH_SECRET=your-secure-refresh-secret
FRONTEND_URL=http://localhost:5173
```

### 1.3 Start Both Servers
```bash
# Terminal 1 - Backend
cd clockwork-backend
npm install
npm run dev

# Terminal 2 - Frontend
cd Clockwork-frontend
npm install
npm run dev
```

## Phase 2: API Service Layer

### 2.1 Create API Configuration
Update your existing API service:

```javascript
// Clockwork-frontend/src/services/api.js
import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';

// Create axios instance
const api = axios.create({
  baseURL: `${API_URL}/api`,
  headers: {
    'Content-Type': 'application/json',
  },
  withCredentials: true
});

// Request interceptor to add token
api.interceptors.request.use(
  (config) => {
    const token = sessionStorage.getItem('clockworkToken');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor for error handling
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    
    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;
      
      try {
        const refreshToken = sessionStorage.getItem('clockworkRefreshToken');
        const response = await axios.post(`${API_URL}/api/auth/refresh`, {
          refreshToken
        });
        
        const { token } = response.data;
        sessionStorage.setItem('clockworkToken', token);
        
        originalRequest.headers.Authorization = `Bearer ${token}`;
        return api(originalRequest);
      } catch (refreshError) {
        // Refresh failed, redirect to login
        sessionStorage.removeItem('clockworkToken');
        sessionStorage.removeItem('clockworkRefreshToken');
        sessionStorage.removeItem('clockworkUser');
        window.location.href = '/';
        return Promise.reject(refreshError);
      }
    }
    
    return Promise.reject(error);
  }
);

export default api;
```

### 2.2 Authentication Service
```javascript
// Clockwork-frontend/src/services/auth.js
import api from './api';

export const authService = {
  async login(email, password) {
    const response = await api.post('/auth/login', { email, password });
    const { token, refreshToken, user } = response.data;
    
    sessionStorage.setItem('clockworkToken', token);
    sessionStorage.setItem('clockworkRefreshToken', refreshToken);
    sessionStorage.setItem('clockworkUser', JSON.stringify(user));
    
    return { user, token };
  },

  async signup(userData) {
    const response = await api.post('/auth/signup', userData);
    const { token, refreshToken, user } = response.data;
    
    sessionStorage.setItem('clockworkToken', token);
    sessionStorage.setItem('clockworkRefreshToken', refreshToken);
    sessionStorage.setItem('clockworkUser', JSON.stringify(user));
    
    return { user, token };
  },

  async logout() {
    try {
      await api.post('/auth/logout');
    } finally {
      sessionStorage.removeItem