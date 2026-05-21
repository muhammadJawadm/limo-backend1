module.exports = {
  apps: [
    {
      name: 'Limo-backend',
      script: 'server.js',            // ✅ root level, not src/
      watch: true,
      ignore_watch: [
        'node_modules',
        'logs',
        '*.log'
      ],
      env: {
        NODE_ENV: 'development',
        PORT: 3000
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000
      }
    }
  ]
};