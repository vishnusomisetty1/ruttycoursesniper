/**
 * PM2 process definition.
 *
 * PM2 is a small "process supervisor": it keeps the worker running, restarts it
 * if it crashes, and can start it again automatically after a reboot.
 *
 *   npm install -g pm2
 *   pm2 start ecosystem.config.cjs
 *   pm2 logs rutgers-sniper
 *   pm2 save && pm2 startup      # survive reboots
 *
 * This runs on the CPU only. There is no GPU work in a poll — it is one HTTP
 * request plus a hash-set lookup.
 */
module.exports = {
  apps: [
    {
      name: 'rutgers-sniper',
      script: 'node_modules/.bin/tsx',
      args: 'src/worker/main.ts',
      cwd: __dirname,
      interpreter: 'none',

      instances: 1,
      exec_mode: 'fork',

      autorestart: true,
      watch: false,
      max_restarts: 50,
      // Wait 5s before restarting so a Rutgers outage doesn't cause a hot loop.
      restart_delay: 5000,
      exp_backoff_restart_delay: 1000,
      max_memory_restart: '300M',

      // Give the worker time to finish its cycle on SIGINT/SIGTERM.
      kill_timeout: 15000,

      env: {
        NODE_ENV: 'production',
      },

      out_file: 'logs/worker-out.log',
      error_file: 'logs/worker-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
