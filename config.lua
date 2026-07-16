Config = {}

Config.ClockInCommand = 'clockin'
Config.ClockOutCommand = 'clockout'

-- These should be set in server.cfg. Values here are only development fallbacks.
Config.ApiUrl = GetConvar('tsp_timeclock_api_url', 'http://127.0.0.1:3099')
Config.ApiSecret = GetConvar('tsp_timeclock_api_secret', '')
