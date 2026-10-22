import pino from 'pino';
export function createLogger(level = 'info') {
  return pino({
    level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'password',
        'passwordHash',
        'token',
        'access_token',
        'analytics_token',
        'authorization',
        'MONGODB_URI',
        'JWT_SECRET',
        'UPSTOX_ANALYTICS_TOKEN',
        'GNEWS_API_KEY',
        'NEWSAPI_KEY',
        'apiKey',
        'apikey',
        'req.headers.x-api-key',
      ],
      censor: '[REDACTED]',
    },
  });
}
