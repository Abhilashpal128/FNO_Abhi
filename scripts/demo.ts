process.env.DATA_MODE = 'demo';
process.env.STORAGE_MODE = 'memory';
process.env.SCHEDULER_ENABLED = 'false';
process.env.NODE_ENV = 'development';
await import('../src/server.js');
