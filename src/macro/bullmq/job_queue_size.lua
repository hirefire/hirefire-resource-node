--------------------------------------------------------------------------------
-- BullMQ Job Queue Size Macro
--
-- Calculates the total job queue size across (specified) queues.
-- Handles both explicitly specified queues and auto-discovery of queues.
--
-- Jobs counted:
--   - Waiting jobs (excluding delay markers)
--   - Active jobs
--   - Prioritized jobs
--   - Delayed jobs (within specified timestamp)
--   - Waiting-children jobs
--   - Jobs in queue groups
--
-- Input:
--   ARGV[1] - Current timestamp (milliseconds * 0x1000)
--   ARGV[2] - Queue prefix (e.g., "bull")
--   ARGV[3..n] - Optional queue names (auto-discovers all queues if omitted)
--
-- Returns:
--   number - Cumulative job queue size across the (specified) queues.
--------------------------------------------------------------------------------

local rcall = redis.call
local unpack = table.unpack or unpack

-- Utility Functions -----------------------------------------------------------

--- Splits a string into parts using a separator, up to a maximum number of splits
-- @param str String to split
-- @param separator Separator character
-- @param limit Maximum number of splits to perform (remaining text kept in last part)
-- @return Multiple values for each split part
local function split_limited(str, separator, limit)
   local parts = {}
   local count = 1
   local start = 1

   while count <= limit do
      local position = string.find(str, separator, start, true)
      if not position then
         table.insert(parts, string.sub(str, start))
         break
      end
      table.insert(parts, string.sub(str, start, position - 1))
      start = position + 1
      count = count + 1
   end

   return unpack(parts)
end

--- Returns length of Redis list with error handling
-- @param key Redis list key
-- @return number List length (0 if error or non-existent)
local function safe_llen(key)
   local ok, result = pcall(rcall, "LLEN", key)
   return ok and result or 0
end

--- Returns cardinality of Redis sorted set with error handling
-- @param key Redis sorted set key
-- @return number Set cardinality (0 if error or non-existent)
local function safe_zcard(key)
   local ok, result = pcall(rcall, "ZCARD", key)
   return ok and result or 0
end

--- Counts elements in sorted set within score range with error handling
-- @param key Redis sorted set key
-- @param min Minimum score (inclusive)
-- @param max Maximum score (inclusive)
-- @return number Count of elements in range (0 if error or non-existent)
local function safe_zcount(key, min, max)
   local ok, result = pcall(rcall, "ZCOUNT", key, min, max)
   return ok and result or 0
end

-- Queue State Functions ------------------------------------------------------

--- Check if a queue is paused via its metadata
-- @param prefix Queue prefix for the Redis key
-- @param queue Queue name to check
-- @return boolean True if queue is paused, false otherwise
local function paused(prefix, queue)
   return rcall("HEXISTS", prefix .. ":" .. queue .. ":meta", "paused") == 1
end

--- Get size of wait list accounting for delay marker at the end
-- @param key Redis key for wait list
-- @return number Actual wait list size excluding delay marker if present
local function wait_size(key)
   local size = safe_llen(key)

   if size > 0 then
      local ok, last_wait_item = pcall(rcall, "LINDEX", key, -1)
      if ok and last_wait_item and string.sub(last_wait_item, 1, 2) == "0:" then
         size = size - 1
      end
   end

   return size
end

--- Calculate size of all queue groups
-- @param prefix Queue prefix
-- @param queue Queue name
-- @return number Total size of all groups
local function all_groups_size(prefix, queue)
   local size = 0
   local cursor = "0"
   local pattern = prefix .. ":" .. queue .. ":groups:*"

   repeat
      local result = rcall("SCAN", cursor, "MATCH", pattern, "COUNT", 1000)
      local keys = result[2]
      cursor = result[1]

      for _, key in ipairs(keys) do
         if string.sub(key, -2) == ":p" then
            size = size + safe_zcard(key)
         else
            size = size + safe_llen(key)
         end
      end
   until cursor == "0"

   return size
end

-- Core Queue Size Functions -------------------------------------------------

--- Calculate size of a single queue across all its states
-- @param prefix Queue prefix for Redis keys
-- @param queue Queue name to calculate
-- @param timestamp Current timestamp for delayed job calculation
-- @return number Total number of jobs requiring processing
local function job_queue_size(prefix, queue, timestamp)
   if paused(prefix, queue) then
      return 0
   end

   local keys = {
      wait = prefix .. ":" .. queue .. ":wait",
      active = prefix .. ":" .. queue .. ":active",
      prioritized = prefix .. ":" .. queue .. ":prioritized",
      delayed = prefix .. ":" .. queue .. ":delayed",
      ["waiting-children"] = prefix .. ":" .. queue .. ":waiting-children"
   }

   local size = 0

   size = size + wait_size(keys.wait)
   size = size + safe_llen(keys.active)
   size = size + safe_zcard(keys.prioritized)
   size = size + safe_zcount(keys.delayed, "-inf", timestamp)
   size = size + safe_zcard(keys["waiting-children"])
   size = size + all_groups_size(prefix, queue)

   return size
end

--- Calculate sum across multiple queues
-- @param prefix Queue prefix
-- @param queues Array of queue names
-- @param timestamp Current timestamp
-- @return number Sum of sizes across all queues
local function sum_job_queue_sizes(prefix, queues, timestamp)
   local size = 0

   for _, queue in ipairs(queues) do
      size = size + job_queue_size(prefix, queue, timestamp)
   end

   return size
end

-- Queue Discovery Functions -------------------------------------------------

--- Extract explicitly specified queue names from ARGV
-- @param argv Redis ARGV array containing queue names from index 3
-- @return table Array of specified queue names
local function extract_queues(argv)
   local queues = {}

   for i = 3, #argv do
      queues[i - 2] = argv[i]
   end

   return queues
end

--- Auto-discover all queue names by scanning Redis keys with prefix
-- @param prefix Queue prefix to scan for
-- @return table Array of unique queue names found in Redis
local function discover_queues(prefix)
   local collected = {}
   local seen = {}
   local cursor = "0"
   local states = {
      wait = true,
      active = true,
      delayed = true,
      prioritized = true,
      ["waiting-children"] = true,
      groups = true
   }

   repeat
      local result = rcall("SCAN", cursor, "MATCH", prefix .. ":*", "COUNT", 1000)
      local keys = result[2]
      cursor = result[1]

      for _, key in ipairs(keys) do
         local _, queue, state = split_limited(key, ":", 3)

         if state and states[state] and not seen[queue] then
            seen[queue] = true
            table.insert(collected, queue)
         end
      end
   until cursor == "0"

   return collected
end

-- Main Execution -----------------------------------------------------------

local timestamp = tonumber(ARGV[1])
local prefix = ARGV[2]
local queues = extract_queues(ARGV)

if #queues == 0 then
   queues = discover_queues(prefix)
end

return sum_job_queue_sizes(prefix, queues, timestamp)
