# Developer App Webhook Registration API

## Overview

This document describes the Developer App Webhook Registration API endpoints that allow developers to subscribe to verification events in a single API call.

**API Base URL:** `http://localhost:4000/api/v1/developer`  
**Authentication:** Bearer token (JWT) required  
**Authorization:** Developer or Admin role required

---

## Endpoints

### 1. Create App
Register a new application that can receive webhook events.

**Endpoint:** `POST /api/v1/developer/apps`

**Request Headers:**
```
Authorization: Bearer <JWT_TOKEN>
Content-Type: application/json
```

**Request Body:**
```json
{
  "name": "My SDK Integration",
  "description": "Optional description of the app"
}
```

**Response (201 Created):**
```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439011",
    "userId": "507f1f77bcf86cd799439012",
    "name": "My SDK Integration",
    "description": "Optional description of the app",
    "isActive": true,
    "createdAt": "2024-10-21T20:55:00.000Z"
  },
  "message": "App created successfully."
}
```

**Error Responses:**
- `400 Bad Request` - Invalid or missing fields
- `401 Unauthorized` - Missing or invalid authentication token
- `409 Conflict` - App name already exists for this user
- `500 Internal Server Error` - Server error

---

### 2. List Apps
Retrieve all applications created by the authenticated developer.

**Endpoint:** `GET /api/v1/developer/apps`

**Request Headers:**
```
Authorization: Bearer <JWT_TOKEN>
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": [
    {
      "id": "507f1f77bcf86cd799439011",
      "userId": "507f1f77bcf86cd799439012",
      "name": "My SDK Integration",
      "description": "Optional description",
      "isActive": true,
      "createdAt": "2024-10-21T20:55:00.000Z"
    }
  ],
  "message": "Apps retrieved successfully."
}
```

---

### 3. Get App Details
Retrieve detailed information about a specific app, including registered webhooks (secrets excluded).

**Endpoint:** `GET /api/v1/developer/apps/:appId`

**Request Headers:**
```
Authorization: Bearer <JWT_TOKEN>
```

**Path Parameters:**
- `appId` (string, required) - The MongoDB ObjectId of the app

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439011",
    "userId": "507f1f77bcf86cd799439012",
    "name": "My SDK Integration",
    "description": "Optional description",
    "webhooks": [
      {
        "id": "wh_1a2b3c4d5e6f7g8h9i0j1k2l",
        "url": "https://api.example.com/webhooks/stellar",
        "events": ["verification.completed", "certificate.minted"],
        "isActive": true,
        "createdAt": "2024-10-21T21:00:00.000Z",
        "updatedAt": "2024-10-21T21:00:00.000Z"
      }
    ],
    "isActive": true,
    "createdAt": "2024-10-21T20:55:00.000Z",
    "updatedAt": "2024-10-21T21:00:00.000Z"
  },
  "message": "App details retrieved successfully."
}
```

**Error Responses:**
- `404 Not Found` - App not found
- `403 Forbidden` - You do not have permission to access this app
- `401 Unauthorized` - Missing or invalid authentication token

---

### 4. Register Webhook (PRIMARY ENDPOINT)
Register a webhook subscription for an app to receive verification events.

**Endpoint:** `POST /api/v1/developer/apps/:appId/webhooks`

**Request Headers:**
```
Authorization: Bearer <JWT_TOKEN>
Content-Type: application/json
```

**Path Parameters:**
- `appId` (string, required) - The MongoDB ObjectId of the app

**Request Body:**
```json
{
  "url": "https://api.example.com/webhooks/stellar",
  "events": [
    "verification.completed",
    "verification.failed",
    "certificate.minted"
  ]
}
```

**Supported Events:**
- `verification.completed` - Fired when a verification job completes successfully
- `verification.failed` - Fired when a verification job fails
- `certificate.minted` - Fired when a certificate is minted on-chain

**Response (201 Created):**
```json
{
  "success": true,
  "data": {
    "id": "wh_1a2b3c4d5e6f7g8h9i0j1k2l",
    "url": "https://api.example.com/webhooks/stellar",
    "events": ["verification.completed", "verification.failed", "certificate.minted"],
    "secret": "wh_sec_abcdef123456789abcdef123456789abcdef123456789abcdef123456789a",
    "createdAt": "2024-10-21T21:00:00.000Z"
  },
  "message": "Webhook registered successfully. Store the secret securely."
}
```

**Important:** The webhook secret is only returned once during registration. Store it securely. You'll need it to verify incoming webhook payloads using HMAC-SHA256.

**Error Responses:**
- `400 Bad Request` - Invalid webhook URL or empty events array
- `401 Unauthorized` - Missing or invalid authentication token
- `403 Forbidden` - You do not have permission to modify this app
- `404 Not Found` - App not found
- `409 Conflict` - App is inactive
- `500 Internal Server Error` - Server error

---

## Webhook Payload Verification

When your webhook endpoint receives an event, verify the payload using the HMAC secret:

**Webhook Event Payload:**
```json
{
  "event": "verification.completed",
  "jobId": "507f1f77bcf86cd799439013",
  "contentHash": "abc123def456...",
  "status": "completed",
  "timestamp": "2024-10-21T21:05:00.000Z",
  "txHash": "abc123def456abc123def456abc123def456abc123def456abc123def456abc1",
  "certificateId": "cert_12345",
  "errorMessage": null
}
```

**Verification Header:**
```
X-StellarProof-Signature: <HMAC-SHA256-HEX>
```

**Example Verification (Node.js):**
```typescript
import * as crypto from 'crypto';

function verifyWebhookSignature(
  payload: string,
  secret: string,
  signature: string
): boolean {
  const computedSignature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  
  // Timing-safe comparison
  return crypto.timingSafeEqual(
    Buffer.from(computedSignature),
    Buffer.from(signature)
  );
}

// In your webhook handler:
const payload = JSON.stringify(req.body);
const signature = req.headers['x-stellarproof-signature'];

if (!verifyWebhookSignature(payload, webhookSecret, signature)) {
  console.error('Invalid webhook signature');
  res.status(401).send('Unauthorized');
  return;
}

// Process the webhook event
handleVerificationEvent(req.body);
```

---

## Error Codes

| Code | Status | Description |
|------|--------|-------------|
| `VALIDATION_ERROR` | 400 | Request body or parameters failed validation |
| `MISSING_USER_ID` | 400 | User ID is required but missing |
| `INVALID_APP_NAME` | 400 | App name is required and must be a non-empty string |
| `INVALID_WEBHOOK_URL` | 400 | Webhook URL must be a valid HTTP/HTTPS URL |
| `INVALID_EVENTS` | 400 | At least one event must be specified |
| `UNAUTHORIZED` | 401 | Authentication required or invalid token |
| `APP_FORBIDDEN` | 403 | You do not have permission to access/modify this app |
| `APP_INACTIVE` | 409 | Cannot register webhooks for an inactive app |
| `APP_NAME_EXISTS` | 409 | App name already exists for this user |
| `APP_NOT_FOUND` | 404 | The requested app does not exist |
| `MISSING_APP_ID` | 400 | App ID is required but missing |

---

## Implementation Details

### Architecture
The implementation follows the strict layered architecture pattern:

1. **Controller Layer** (`developer.controller.ts`)
   - Handles HTTP requests/responses
   - Delegates to service layer
   - Error handling via next middleware

2. **Service Layer** (`app.service.ts`)
   - Business logic for app and webhook management
   - Validation and authorization checks
   - Database operations

3. **Model Layer** (`App.model.ts`)
   - Mongoose schema and interfaces
   - Data persistence
   - Validation at model level

4. **Types Layer** (`app.types.ts`)
   - TypeScript interfaces and DTOs
   - Enum definitions
   - API response contracts

5. **Middleware Layer**
   - `app.validation.ts` - Zod schemas for request validation
   - `zodValidate.ts` - Body validation middleware
   - `zodValidateParams.ts` - Parameter validation middleware
   - Authentication and authorization middleware

### Security Features
- ✅ HMAC-SHA256 secrets for webhook payload verification (generated with crypto.randomBytes)
- ✅ Bearer token JWT authentication required
- ✅ Role-based access control (developer/admin only)
- ✅ User ownership verification for all operations
- ✅ Input validation using Zod schemas
- ✅ Timing-safe comparison for HMAC verification
- ✅ All sensitive data (secrets) excluded from GET responses

### Database Schema
```typescript
// App Document
{
  userId: ObjectId,              // Reference to User
  name: String,                  // Unique per user
  description: String,           // Optional
  webhooks: [                    // Array of webhook subscriptions
    {
      id: String,                // Unique webhook ID (wh_...)
      url: String,               // HTTPS URL for webhook endpoint
      events: [String],          // Array of subscribed events
      secret: String,            // HMAC secret (hex-encoded)
      isActive: Boolean,
      createdAt: Date,
      updatedAt: Date
    }
  ],
  isActive: Boolean,
  createdAt: Date,
  updatedAt: Date
}
```

---

## Testing

### Using Postman

**1. Register a Developer App:**
```
POST http://localhost:4000/api/v1/developer/apps
Authorization: Bearer <YOUR_JWT_TOKEN>
Content-Type: application/json

{
  "name": "My Test App",
  "description": "Testing webhook registration"
}
```

**2. Register a Webhook:**
```
POST http://localhost:4000/api/v1/developer/apps/<APP_ID>/webhooks
Authorization: Bearer <YOUR_JWT_TOKEN>
Content-Type: application/json

{
  "url": "https://webhook.site/unique-id",
  "events": ["verification.completed", "certificate.minted"]
}
```

**3. Get App Details:**
```
GET http://localhost:4000/api/v1/developer/apps/<APP_ID>
Authorization: Bearer <YOUR_JWT_TOKEN>
```

### Using cURL

```bash
# Create app
curl -X POST http://localhost:4000/api/v1/developer/apps \
  -H "Authorization: Bearer <JWT_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Test App",
    "description": "Testing webhook registration"
  }'

# Register webhook
curl -X POST http://localhost:4000/api/v1/developer/apps/<APP_ID>/webhooks \
  -H "Authorization: Bearer <JWT_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://webhook.site/unique-id",
    "events": ["verification.completed"]
  }'
```

---

## Changelog

### v1.0.0 (2024-10-21)
- ✨ Initial release of Developer App Webhook Registration API
- Implemented CREATE app endpoint
- Implemented READ app details endpoint
- Implemented LIST apps endpoint
- Implemented REGISTER webhook endpoint
- Added comprehensive validation and error handling
- Added HMAC secret generation for webhook verification
