// Centralized configuration with environment variable support

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  logLevel: process.env.LOG_LEVEL || 'info',
  vaultPath: process.env.VAULT_PATH || './vault',
};
