--[=[
    gm_monitor.lua  —  Anti-Corruption GM Monitor
    ALE (AzerothCore Lua Engine)  /  AzerothCore 3.3.5a

    Intercepts GM rank 2 (SEC_GAMEMASTER) commands, logs them to auth
    database, and notifies online administrators (rank >= 3).

    Monitored commands (all case-insensitive):
      additem, modify speed*, modify money, send items,
      learn, setskill, npc add, tele, revive, level

    * modify speed is only logged when used on ANOTHER player, never on self.

    Installation:
      1. Place this file in lua_scripts/
      2. Run '.reload eluna' on the server console
      3. Apply sql/auth_setup.sql to your auth database
      4. Start the dashboard: cd dashboard && npm install && npm start
]=]

local MONITORED_PREFIXES = {
    "additem",
    "modify speed",
    "modify money",
    "send items",
    "learn",
    "setskill",
    "npc add",
    "tele",
    "revive",
    "level"
}

local COLOR_RED    = "|cffFF0000"
local COLOR_YELLOW = "|cffFFFF00"
local COLOR_ORANGE = "|cffFF8000"
local COLOR_RESET  = "|r"

local function OnCommand(event, player, command, chatHandler)
    if not player then
        return
    end

    if player:GetGMRank() ~= 2 then
        return
    end

    local cmdLower = string.lower(command or "")
    local matchedPrefix = nil
    for i = 1, #MONITORED_PREFIXES do
        if string.find(cmdLower, MONITORED_PREFIXES[i], 1, true) == 1 then
            matchedPrefix = MONITORED_PREFIXES[i]
            break
        end
    end
    if not matchedPrefix then
        return
    end

    local targetName = nil
    local isOtherPlayer = false
    local target = player:GetSelection()
    if target and target:IsPlayer() then
        targetName = target:GetName()
        if target:GetGUID() ~= player:GetGUID() then
            isOtherPlayer = true
        end
    end

    if matchedPrefix == "modify speed" and not isOtherPlayer then
        return
    end

    local loggedCmd = command
    if targetName then
        loggedCmd = command .. " [target: " .. targetName .. "]"
    end

    local escapedCmd = string.gsub(loggedCmd, "'", "''")
    local accountId  = player:GetAccountId()
    local charName   = player:GetName()

    local query = string.format(
        "INSERT INTO custom_gm_action_logs (account_id, character_name, command_text) VALUES (%d, '%s', '%s')",
        accountId,
        charName,
        escapedCmd
    )
    AuthDBExecute(query)

    local alertCmd = command
    if targetName then
        alertCmd = command .. "  →  |cff00FF00" .. targetName .. "|r"
    end

    local allPlayers = GetPlayersInWorld()
    if allPlayers then
        local alertMsg = string.format(
            "%s[GM Monitor]%s %s%s%s used: %s%s%s",
            COLOR_RED, COLOR_RESET,
            COLOR_YELLOW, charName, COLOR_RESET,
            COLOR_ORANGE, alertCmd, COLOR_RESET
        )
        for i = 1, #allPlayers do
            local p = allPlayers[i]
            if p and p:GetGMRank() >= 3 then
                p:SendBroadcastMessage(alertMsg)
            end
        end
    end
end

RegisterPlayerEvent(42, OnCommand, 0)
