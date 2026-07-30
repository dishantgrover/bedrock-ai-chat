/**
 * HTTP entry point.
 *
 * Serves the built frontend and the authenticated API. All AWS access happens
 * here using the instance role; the browser only ever holds a Cognito JWT.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import helmet from 'helmet';

import { requireAuth } from './auth.js';
import {
  COGNITO_CLIENT_ID,
  COGNITO_USER_POOL_ID,
  DAILY_TOKEN_BUDGET,
  PORT,
  REGION,
  STATIC_DIR,
} from './config.js';
import { publicModels } from './models.js';
import { chatRouter } from './routes/chat.js';
import { conversationsRouter } from './routes/conversations.js';
import { getUsageToday } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const staticRoot = path.resolve(here, '..', STATIC_DIR);

const app = express();

app.set('trust proxy', 1);

// Content-Security-Policy is set explicitly: the app loads no third-party
// scripts, and `connect-src 'self'` keeps the SSE stream same-origin.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", `https://cognito-idp.${REGION}.amazonaws.com`],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    // Streaming responses are same-origin; the default COEP breaks nothing here
    // but is unnecessary.
    crossOriginEmbedderPolicy: false,
  }),
);

app.use(express.json({ limit: '1mb' }));

/** Liveness probe, intentionally unauthenticated and free of account detail. */
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

/**
 * Configuration the browser needs to run the Cognito login flow. These are
 * public identifiers, not secrets.
 */
app.get('/api/config', (_req, res) => {
  res.json({
    region: REGION,
    userPoolId: COGNITO_USER_POOL_ID,
    clientId: COGNITO_CLIENT_ID,
    models: publicModels(),
    dailyTokenBudget: DAILY_TOKEN_BUDGET,
  });
});

app.get('/api/me', requireAuth, async (req, res) => {
  const outputTokensToday = await getUsageToday(req.user.id);
  res.json({
    user: { id: req.user.id, username: req.user.username },
    usage: { outputTokensToday, dailyTokenBudget: DAILY_TOKEN_BUDGET },
  });
});

app.use('/api/conversations', requireAuth, conversationsRouter);
app.use('/api/chat', requireAuth, chatRouter);

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Serve the built SPA and route unknown paths to index.html so client-side
// routing works on refresh.
app.use(express.static(staticRoot, { index: 'index.html', maxAge: '1h' }));
app.get('*', (_req, res) => {
  res.sendFile(path.join(staticRoot, 'index.html'), (error) => {
    if (error) {
      res.status(404).send('Not found');
    }
  });
});

// Final error handler. Logs server-side, returns nothing revealing.
app.use((error, _req, res, _next) => {
  console.error('unhandled error', { message: error?.message, stack: error?.stack });
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`ai-chat server listening on :${PORT} (region ${REGION})`);
});
