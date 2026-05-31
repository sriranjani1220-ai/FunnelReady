# FunnelReady AI

**Is your Salesforce org AI-ready?** FunnelReady scans your Salesforce data and tells you exactly what's broken — missing fields, duplicates, junk records, format inconsistencies, and integrity issues — so you can clean up before rolling out Agentforce or any AI layer.

**Live Demo**: [funnelready-production.up.railway.app](https://funnelready-production.up.railway.app/)

## The Problem

Organizations managing Salesforce orgs often lack visibility into their data quality. Dirty data — incomplete records, duplicates, junk entries, inconsistent formats — silently undermines AI adoption, pipeline accuracy, and forecasting. Most teams don't discover these issues until an AI initiative fails or a migration goes sideways.

## What FunnelReady Does

FunnelReady connects to any Salesforce org via OAuth, runs a comprehensive data quality scan across Leads, Contacts, Accounts, and Opportunities, and returns:

- **Overall Data Quality Grade** (A through F) with a numeric score
- **Per-object scores** with drill-down into 5 diagnostic categories
- **Record-level findings** so you know exactly which records need fixing

### The 5 Diagnostic Checks

| Check | What it catches |
|-------|----------------|
| **Field Completeness** | Missing values across 10 critical fields per object (Email, Phone, Amount, etc.) |
| **Duplicate Detection** | Duplicate Leads/Contacts by email, Accounts by normalized name |
| **Format Consistency** | Mixed phone formats, inconsistent Account name casing, State/Country abbreviation mismatches |
| **Junk Data Detection** | Obvious junk ("test", "asdf", "TBD") and suspicious patterns (@example.com, single-char names) |
| **Data Integrity** | Unrealistic amounts ($1B+ opps, negative values), stale pipelines, orphan contacts, fake lead conversions |

## Tech Stack

- **Frontend**: Vanilla HTML/CSS/JS (single-page app in `public/index.html`)
- **Backend**: Node.js + Express
- **Salesforce Integration**: JSforce + OAuth 2.0 (Connected App)
- **AI**: Claude API via `@anthropic-ai/sdk`
- **Hosting**: Railway

## Architecture

```
Browser (index.html)
  |
  |-- GET /oauth/login --> Salesforce OAuth consent screen
  |-- GET /oauth/callback --> receives auth code, stores session
  |-- GET /api/status --> check if connected
  |-- GET /api/scan --> triggers full data quality scan
  |
Express Server (server.js)
  |
  |-- requireAuth middleware --> rehydrates JSforce connection from session
  |-- runFullScan(conn) --> scanner.js
  |
Scanner Engine (scanner.js)
  |-- 1.1 Field Completeness
  |-- 1.2 Duplicate Detection
  |-- 1.3 Format Consistency
  |-- 1.4 Junk Data Detection
  |-- 1.5 Data Integrity Validation
  |-- 1.6 Object-Level Scoring
  |-- 1.7 Overall Grade Calculation
```

## Getting Started

### Prerequisites

- Node.js 18+
- A Salesforce org (any edition with API access)
- A Salesforce Connected App with OAuth enabled

### Setup

1. Clone the repo:
   ```bash
   git clone https://github.com/sriranjani1220-ai/FunnelReady.git
   cd FunnelReady
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file (see `.env.example`):
   ```
   SF_CLIENT_ID=your_connected_app_client_id
   SF_CLIENT_SECRET=your_connected_app_client_secret
   SF_CALLBACK_URL=http://localhost:3000/oauth/callback
   ANTHROPIC_API_KEY=your_claude_api_key
   SESSION_SECRET=any_random_string
   PORT=3000
   ```

4. Start the server:
   ```bash
   npm start
   ```

5. Open `http://localhost:3000`, click **Connect Your Salesforce Org**, and authorize.

6. Click **Scan My Org** to run the data quality analysis.

### Salesforce Connected App Setup

1. In Salesforce Setup, go to **App Manager** > **New Connected App**
2. Enable OAuth Settings
3. Set callback URL to `http://localhost:3000/oauth/callback`
4. Select scopes: `api`, `refresh_token`
5. Copy the Consumer Key and Secret into your `.env`

## How Scoring Works

Each object (Lead, Contact, Account, Opportunity) gets a score from 0-100 based on the average of all 5 checks. The overall grade is the average across all 4 objects:

| Grade | Score Range |
|-------|-------------|
| A | 90 - 100 |
| B | 75 - 89 |
| C | 60 - 74 |
| D | 40 - 59 |
| F | 0 - 39 |

## Project Structure

```
FunnelReady/
  server.js          # Express server, OAuth routes, API endpoints
  scanner.js         # Data quality scan engine (7 sub-checks)
  package.json       # Dependencies and scripts
  .env.example       # Environment variable template
  public/
    index.html       # Full frontend (SPA with drill-down UI)
```

## Roadmap

- [ ] Feature 2: Funnel Health Analysis
- [ ] Feature 3: Pipeline Integrity Check
- [ ] Feature 4: Record Relationship Audit
- [ ] Feature 5: Lead Management Assessment
- [ ] Feature 6: AI Readiness Report
- [ ] Feature 7: Recommendations Engine
- [ ] CSV download of flagged records per field
- [ ] AI-powered recommendations via Claude

## License

ISC
