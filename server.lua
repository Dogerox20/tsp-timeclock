local resourceName = GetCurrentResourceName()
local activeBySource = {}

local function notify(source, message, color)
    if source == 0 then
        print(('[%s] %s'):format(resourceName, message))
        return
    end

    TriggerClientEvent('chat:addMessage', source, {
        color = color or { 91, 155, 213 },
        multiline = false,
        args = { 'Time Clock', message }
    })
end

local function discordIdFor(source)
    for _, identifier in ipairs(GetPlayerIdentifiers(source)) do
        local discordId = identifier:match('^discord:(%d+)$')
        if discordId then return discordId end
    end
    return nil
end

local function request(path, payload, callback)
    if Config.ApiSecret == '' then
        callback(false, 'The time-clock API secret is not configured.')
        return
    end

    PerformHttpRequest(Config.ApiUrl .. path, function(status, body)
        local decoded = nil
        if body and body ~= '' then
            local ok, value = pcall(json.decode, body)
            if ok then decoded = value end
        end

        if status >= 200 and status < 300 then
            callback(true, decoded or {})
            return
        end

        local message = decoded and decoded.error or ('Time-clock service returned HTTP %s.'):format(status)
        callback(false, message)
    end, 'POST', json.encode(payload), {
        ['Content-Type'] = 'application/json',
        ['X-Timeclock-Secret'] = Config.ApiSecret
    })
end

RegisterCommand(Config.ClockInCommand, function(source)
    if source == 0 then
        notify(source, 'This command must be used by a player.')
        return
    end

    if activeBySource[source] then
        notify(source, 'You are already clocked in.', { 255, 193, 7 })
        return
    end

    local discordId = discordIdFor(source)
    if not discordId then
        notify(source, 'Discord is not linked. Restart Discord and FiveM, then reconnect.', { 220, 53, 69 })
        return
    end

    request('/api/clockin', {
        discordId = discordId,
        playerName = GetPlayerName(source),
        serverId = source
    }, function(ok, result)
        if not ok then
            notify(source, tostring(result), { 220, 53, 69 })
            return
        end

        activeBySource[source] = result.sessionId
        notify(source, ('Clocked in as %s.'):format(result.rosterName or GetPlayerName(source)), { 25, 135, 84 })
    end)
end, false)

local function clockOut(source, reason, shouldNotify)
    local discordId = discordIdFor(source)
    local sessionId = activeBySource[source]

    if not discordId and not sessionId then
        if shouldNotify then notify(source, 'You are not clocked in.', { 255, 193, 7 }) end
        return
    end

    request('/api/clockout', {
        discordId = discordId,
        sessionId = sessionId,
        reason = reason,
        playerName = GetPlayerName(source)
    }, function(ok, result)
        if ok then
            activeBySource[source] = nil
            if shouldNotify then
                notify(source, ('Clocked out. %s is awaiting approval.'):format(result.durationLabel), { 25, 135, 84 })
            end
        elseif shouldNotify then
            notify(source, tostring(result), { 220, 53, 69 })
        else
            print(('[%s] Automatic clock-out failed for %s: %s'):format(resourceName, tostring(source), tostring(result)))
        end
    end)
end

RegisterCommand(Config.ClockOutCommand, function(source)
    if source == 0 then
        notify(source, 'This command must be used by a player.')
        return
    end
    clockOut(source, 'command', true)
end, false)

AddEventHandler('playerDropped', function()
    clockOut(source, 'disconnect', false)
    activeBySource[source] = nil
end)
AddEventHandler('onResourceStart', function(startedResource)
    if startedResource ~= resourceName then return end
    if Config.ApiSecret == '' then
        print(('[%s] WARNING: tsp_timeclock_api_secret is empty; commands will not work.'):format(resourceName))
    end
end)
