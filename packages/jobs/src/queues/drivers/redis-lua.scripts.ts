/**
 * Atomic Redis Lua scripts for `RedisQueueDriver`.
 *
 * Compatible with Redis 6/7 (`EVAL` / `EVALSHA` with built-in `cjson`).
 *
 * Key layout per queue (`base = "${prefix}:${queueName}"`):
 * - `jobs`       (HASH):   jobId -> JSON serialized `Job`
 * - `idempotency`(HASH):   idempotencyKey -> jobId
 * - `waiting`    (ZSET):   member = jobId, score = -priority * 1e9 + seq
 * - `delayed`    (ZSET):   member = jobId, score = processAfter (epoch ms)
 * - `active`     (ZSET):   member = jobId, score = leaseExpiresAt (epoch ms)
 * - `leases`     (HASH):   jobId -> active worker lease token
 * - `stalled`    (HASH):   jobId -> stalled count integer
 * - `dlq`        (LIST):   dead-letter job IDs
 * - `seq`        (STRING): monotonically increasing FIFO sequence
 * - `completed`  (STRING): completed jobs counter
 * - `failed`     (STRING): failed/dead-lettered jobs counter
 */

/**
 * Atomically checks idempotency key and jobId uniqueness, stores job JSON in
 * the jobs hash, and inserts into either the delayed ZSET or priority waiting ZSET.
 *
 * KEYS[1]: jobs hash
 * KEYS[2]: idempotency hash
 * KEYS[3]: waiting zset
 * KEYS[4]: delayed zset
 * KEYS[5]: seq string counter
 * KEYS[6]: groupMap hash (optional: jobId -> groupId)
 *
 * ARGV[1]: jobId
 * ARGV[2]: jobJson
 * ARGV[3]: priority (number)
 * ARGV[4]: processAfter (epoch ms)
 * ARGV[5]: now (epoch ms)
 * ARGV[6]: idempotencyKey (empty string if none)
 * ARGV[7]: idempotencyTtlMs (optional positive ms for PEXPIRE on idempotency hash)
 * ARGV[8]: groupId (optional group/tenant identifier)
 *
 * Returns: { createdFlag (1 | 0), jobJson }
 */
export const LUA_ENQUEUE_JOB = `
local jobsKey = KEYS[1]
local idempKey = KEYS[2]
local waitingKey = KEYS[3]
local delayedKey = KEYS[4]
local seqKey = KEYS[5]
local groupMapKey = KEYS[6]

local jobId = ARGV[1]
local jobJson = ARGV[2]
local priority = tonumber(ARGV[3]) or 0
local processAfter = tonumber(ARGV[4]) or 0
local now = tonumber(ARGV[5]) or 0
local idempotency = ARGV[6] or ""
local idempotencyTtlMs = tonumber(ARGV[7]) or 0
local groupId = ARGV[8] or ""

if idempotency ~= "" then
  local existingId = redis.call("HGET", idempKey, idempotency)
  if existingId then
    local existingRaw = redis.call("HGET", jobsKey, existingId)
    if existingRaw then
      return { 0, existingRaw }
    end
    redis.call("HDEL", idempKey, idempotency)
  end
end

local existingById = redis.call("HGET", jobsKey, jobId)
if existingById then
  return { 0, existingById }
end

redis.call("HSET", jobsKey, jobId, jobJson)
if groupMapKey and groupMapKey ~= "" and groupId ~= "" then
  redis.call("HSET", groupMapKey, jobId, groupId)
end
if idempotency ~= "" then
  redis.call("HSET", idempKey, idempotency, jobId)
  if idempotencyTtlMs > 0 then
    redis.call("PEXPIRE", idempKey, idempotencyTtlMs)
  end
end

if processAfter > now then
  redis.call("ZADD", delayedKey, processAfter, jobId)
else
  local seq = redis.call("INCR", seqKey)
  local score = (-priority * 1000000000) + seq
  redis.call("ZADD", waitingKey, score, jobId)
end

return { 1, jobJson }
`.trim();

/**
 * Atomically promotes ready delayed jobs into the priority waiting ZSET, pops
 * the highest-priority / oldest job, assigns a worker lease token and
 * `leaseExpiresAt`, and records the active lease in the active ZSET + leases hash.
 *
 * KEYS[1]: jobs hash
 * KEYS[2]: waiting zset
 * KEYS[3]: delayed zset
 * KEYS[4]: active zset (score = leaseExpiresAt)
 * KEYS[5]: leases hash (jobId -> token)
 * KEYS[6]: seq string counter
 *
 * ARGV[1]: now (epoch ms)
 * ARGV[2]: lockDurationMs
 * ARGV[3]: leaseToken
 *
 * Returns: updated jobJson string, or nil when no job is ready.
 */
export const LUA_DEQUEUE_JOB = `
local jobsKey = KEYS[1]
local waitingKey = KEYS[2]
local delayedKey = KEYS[3]
local activeKey = KEYS[4]
local leasesKey = KEYS[5]
local seqKey = KEYS[6]

local now = tonumber(ARGV[1]) or 0
local lockDurationMs = tonumber(ARGV[2]) or 30000
local leaseToken = ARGV[3]

local function preserveStacktrace(job)
  local stack = job["stacktrace"]
  if type(stack) ~= "table" then
    stack = {}
    job["stacktrace"] = stack
  end
  if next(stack) == nil and cjson.empty_array_mt then
    setmetatable(stack, cjson.empty_array_mt)
  end
end

local dueIds = redis.call("ZRANGEBYSCORE", delayedKey, "-inf", now)
for i = 1, #dueIds do
  local dueId = dueIds[i]
  local removed = redis.call("ZREM", delayedKey, dueId)
  if removed > 0 then
    local raw = redis.call("HGET", jobsKey, dueId)
    if raw then
      local job = cjson.decode(raw)
      job["status"] = "waiting"
      preserveStacktrace(job)
      redis.call("HSET", jobsKey, dueId, cjson.encode(job))
      local seq = redis.call("INCR", seqKey)
      local prio = tonumber(job["priority"]) or 0
      local score = (-prio * 1000000000) + seq
      redis.call("ZADD", waitingKey, score, dueId)
    end
  end
end

while true do
  local candidates = redis.call("ZRANGE", waitingKey, 0, 0)
  if #candidates == 0 then
    return nil
  end
  local jobId = candidates[1]
  redis.call("ZREM", waitingKey, jobId)
  local raw = redis.call("HGET", jobsKey, jobId)
  if raw then
    local job = cjson.decode(raw)
    local leaseExpiresAt = now + lockDurationMs
    job["status"] = "active"
    job["startedAt"] = now
    job["leaseToken"] = leaseToken
    job["leaseExpiresAt"] = leaseExpiresAt
    preserveStacktrace(job)
    local updated = cjson.encode(job)
    redis.call("HSET", jobsKey, jobId, updated)
    redis.call("ZADD", activeKey, leaseExpiresAt, jobId)
    redis.call("HSET", leasesKey, jobId, leaseToken)
    return updated
  end
end
`.trim();

/**
 * Atomically promotes due delayed jobs, enforces an optional sliding-window rate
 * limiter, enforces optional per-group active concurrency caps with fair round-robin
 * selection across eligible groups, activates the selected job with a worker lease,
 * and records rate-limit & group-active counters in one Redis round-trip.
 *
 * KEYS[1]:  jobs hash
 * KEYS[2]:  waiting zset
 * KEYS[3]:  delayed zset
 * KEYS[4]:  active zset (score = leaseExpiresAt)
 * KEYS[5]:  leases hash (jobId -> token)
 * KEYS[6]:  seq string counter
 * KEYS[7]:  groupActive hash (groupId -> active count)
 * KEYS[8]:  groupRr zset (member = groupKey, score = lastServed rrSeq)
 * KEYS[9]:  groupRrSeq string counter
 * KEYS[10]: groupMap hash (jobId -> groupId)
 * KEYS[11]: rateLimit zset (score = dequeue timestamp ms, member = unique token)
 *
 * ARGV[1]: now (epoch ms)
 * ARGV[2]: lockDurationMs
 * ARGV[3]: leaseToken
 * ARGV[4]: maxPerGroup (0 when groupConcurrency is disabled)
 * ARGV[5]: groupOverridesJson (JSON object string of per-group overrides, e.g. "{}")
 * ARGV[6]: rateLimitMax (0 when limiter is disabled)
 * ARGV[7]: rateLimitDurationMs (0 when limiter is disabled)
 *
 * Returns:
 *   - { "job", updatedJobJson } when a job was dequeued
 *   - { "rate_limited", tostring(nextAvailableEpochMs) } when rate-limit quota is full
 *   - nil when no eligible waiting job exists
 */
export const LUA_DEQUEUE_FAIR_JOB = `
local jobsKey = KEYS[1]
local waitingKey = KEYS[2]
local delayedKey = KEYS[3]
local activeKey = KEYS[4]
local leasesKey = KEYS[5]
local seqKey = KEYS[6]
local groupActiveKey = KEYS[7]
local groupRrKey = KEYS[8]
local groupRrSeqKey = KEYS[9]
local groupMapKey = KEYS[10]
local rateLimitKey = KEYS[11]

local now = tonumber(ARGV[1]) or 0
local lockDurationMs = tonumber(ARGV[2]) or 30000
local leaseToken = ARGV[3]
local maxPerGroup = tonumber(ARGV[4]) or 0
local groupOverridesJson = ARGV[5] or "{}"
local rateLimitMax = tonumber(ARGV[6]) or 0
local rateLimitDurationMs = tonumber(ARGV[7]) or 0

local function preserveStacktrace(job)
  local stack = job["stacktrace"]
  if type(stack) ~= "table" then
    stack = {}
    job["stacktrace"] = stack
  end
  if next(stack) == nil and cjson.empty_array_mt then
    setmetatable(stack, cjson.empty_array_mt)
  end
end

local dueIds = redis.call("ZRANGEBYSCORE", delayedKey, "-inf", now)
for i = 1, #dueIds do
  local dueId = dueIds[i]
  local removed = redis.call("ZREM", delayedKey, dueId)
  if removed > 0 then
    local raw = redis.call("HGET", jobsKey, dueId)
    if raw then
      local job = cjson.decode(raw)
      job["status"] = "waiting"
      preserveStacktrace(job)
      redis.call("HSET", jobsKey, dueId, cjson.encode(job))
      local gid = job["groupId"]
      if groupMapKey and groupMapKey ~= "" and type(gid) == "string" and gid ~= "" then
        redis.call("HSET", groupMapKey, dueId, gid)
      end
      local seq = redis.call("INCR", seqKey)
      local prio = tonumber(job["priority"]) or 0
      local score = (-prio * 1000000000) + seq
      redis.call("ZADD", waitingKey, score, dueId)
    end
  end
end

if rateLimitMax > 0 and rateLimitDurationMs > 0 then
  local cutoff = now - rateLimitDurationMs
  redis.call("ZREMRANGEBYSCORE", rateLimitKey, "-inf", cutoff)
  local used = redis.call("ZCARD", rateLimitKey)
  if used >= rateLimitMax then
    local oldest = redis.call("ZRANGE", rateLimitKey, 0, 0, "WITHSCORES")
    local oldestTs = now
    if #oldest >= 2 then
      oldestTs = tonumber(oldest[2]) or now
    end
    return { "rate_limited", tostring(oldestTs + rateLimitDurationMs) }
  end
end

local selectedJobId = nil
local selectedJob = nil
local selectedGroup = ""

if maxPerGroup <= 0 then
  while true do
    local candidates = redis.call("ZRANGE", waitingKey, 0, 0)
    if #candidates == 0 then
      return nil
    end
    local jobId = candidates[1]
    redis.call("ZREM", waitingKey, jobId)
    local raw = redis.call("HGET", jobsKey, jobId)
    if raw then
      selectedJobId = jobId
      selectedJob = cjson.decode(raw)
      local gid = selectedJob["groupId"]
      if type(gid) == "string" and gid ~= "" then
        selectedGroup = gid
      else
        selectedGroup = ""
      end
      break
    end
  end
else
  local overrides = {}
  if groupOverridesJson ~= "" and groupOverridesJson ~= "{}" then
    local ok, parsed = pcall(cjson.decode, groupOverridesJson)
    if ok and type(parsed) == "table" then
      overrides = parsed
    end
  end

  local allWaiting = redis.call("ZRANGE", waitingKey, 0, -1)
  local seenGroup = {}
  local bestJobId = nil
  local bestJob = nil
  local bestGroup = ""
  local bestLastServed = nil

  for i = 1, #allWaiting do
    local jobId = allWaiting[i]
    local gid = redis.call("HGET", groupMapKey, jobId)
    local raw = nil
    local decoded = nil

    if not gid then
      raw = redis.call("HGET", jobsKey, jobId)
      if not raw then
        redis.call("ZREM", waitingKey, jobId)
        gid = nil
      else
        decoded = cjson.decode(raw)
        if type(decoded["groupId"]) == "string" then
          gid = decoded["groupId"]
        else
          gid = ""
        end
      end
    end

    if gid ~= nil then
      if not seenGroup[gid] then
        if not raw then
          raw = redis.call("HGET", jobsKey, jobId)
        end
        if not raw then
          redis.call("ZREM", waitingKey, jobId)
        else
          if not decoded then
            decoded = cjson.decode(raw)
          end
          if decoded["status"] ~= "waiting" then
            redis.call("ZREM", waitingKey, jobId)
          else
            seenGroup[gid] = true
            local eligible = true
            if gid ~= "" then
              local cap = tonumber(overrides[gid]) or maxPerGroup
              local curActive = tonumber(redis.call("HGET", groupActiveKey, gid)) or 0
              if curActive >= cap then
                eligible = false
              end
            end
            if eligible then
              local score = redis.call("ZSCORE", groupRrKey, gid)
              local lastServed = tonumber(score) or 0
              if bestLastServed == nil or lastServed < bestLastServed then
                bestLastServed = lastServed
                bestJobId = jobId
                bestJob = decoded
                bestGroup = gid
                if lastServed == 0 then
                  break
                end
              end
            end
          end
        end
      end
    end
  end

  if not bestJobId or not bestJob then
    return nil
  end
  redis.call("ZREM", waitingKey, bestJobId)
  selectedJobId = bestJobId
  selectedJob = bestJob
  selectedGroup = bestGroup
end

local leaseExpiresAt = now + lockDurationMs
selectedJob["status"] = "active"
selectedJob["startedAt"] = now
selectedJob["leaseToken"] = leaseToken
selectedJob["leaseExpiresAt"] = leaseExpiresAt
preserveStacktrace(selectedJob)
local updated = cjson.encode(selectedJob)
redis.call("HSET", jobsKey, selectedJobId, updated)
redis.call("ZADD", activeKey, leaseExpiresAt, selectedJobId)
redis.call("HSET", leasesKey, selectedJobId, leaseToken)

if selectedGroup ~= "" and groupActiveKey and groupActiveKey ~= "" then
  redis.call("HINCRBY", groupActiveKey, selectedGroup, 1)
end
if maxPerGroup > 0 and groupRrKey and groupRrKey ~= "" and groupRrSeqKey and groupRrSeqKey ~= "" then
  local rrSeq = redis.call("INCR", groupRrSeqKey)
  redis.call("ZADD", groupRrKey, rrSeq, selectedGroup)
end
if rateLimitMax > 0 and rateLimitDurationMs > 0 then
  redis.call("ZADD", rateLimitKey, now, tostring(now) .. ":" .. selectedJobId .. ":" .. leaseToken)
  redis.call("PEXPIRE", rateLimitKey, math.max(1000, rateLimitDurationMs * 2))
end

return { "job", updated }
`.trim();

/**
 * Atomically acknowledges a completed active job, verifies lease token when
 * supplied, clears active/lease/stalled state, increments completed counter,
 * optionally prunes idempotency entry, and removes or persists the completed job payload.
 *
 * KEYS[1]: jobs hash
 * KEYS[2]: active zset
 * KEYS[3]: leases hash
 * KEYS[4]: stalled hash
 * KEYS[5]: completed counter
 * KEYS[6]: idempotency hash (optional)
 * KEYS[7]: groupActive hash (optional)
 * KEYS[8]: groupMap hash (optional)
 *
 * ARGV[1]: jobId
 * ARGV[2]: resultJson (encoded JSON when ARGV[3] == "1")
 * ARGV[3]: hasResult ("1" | "0")
 * ARGV[4]: finishedAt (epoch ms)
 * ARGV[5]: expectedToken (empty string to skip token check)
 * ARGV[6]: pruneIdempotency ("1" | "0", optional)
 *
 * Returns: updated jobJson string, or nil if missing / lease mismatch.
 */
export const LUA_ACK_JOB = `
local jobsKey = KEYS[1]
local activeKey = KEYS[2]
local leasesKey = KEYS[3]
local stalledKey = KEYS[4]
local completedKey = KEYS[5]
local idempKey = KEYS[6]
local groupActiveKey = KEYS[7]
local groupMapKey = KEYS[8]

local jobId = ARGV[1]
local resultJson = ARGV[2]
local hasResult = ARGV[3]
local finishedAt = tonumber(ARGV[4]) or 0
local expectedToken = ARGV[5] or ""
local pruneIdempotency = ARGV[6] or "0"

if expectedToken ~= "" then
  local currentToken = redis.call("HGET", leasesKey, jobId)
  if not currentToken or currentToken ~= expectedToken then
    return nil
  end
end

local wasActive = redis.call("ZREM", activeKey, jobId)
redis.call("HDEL", leasesKey, jobId)
redis.call("HDEL", stalledKey, jobId)

local raw = redis.call("HGET", jobsKey, jobId)
if not raw then
  return nil
end

local job = cjson.decode(raw)
local gid = job["groupId"]
if wasActive > 0 and groupActiveKey and groupActiveKey ~= "" and type(gid) == "string" and gid ~= "" then
  if redis.call("HEXISTS", groupActiveKey, gid) == 1 then
    local rem = redis.call("HINCRBY", groupActiveKey, gid, -1)
    if rem <= 0 then
      redis.call("HDEL", groupActiveKey, gid)
    end
  end
end

job["status"] = "completed"
job["finishedAt"] = finishedAt
job["leaseToken"] = nil
job["leaseExpiresAt"] = nil
if hasResult == "1" then
  job["returnValue"] = cjson.decode(resultJson)
end
local stack = job["stacktrace"]
if type(stack) ~= "table" then
  stack = {}
  job["stacktrace"] = stack
end
if next(stack) == nil and cjson.empty_array_mt then
  setmetatable(stack, cjson.empty_array_mt)
end

redis.call("INCR", completedKey)
local updated = cjson.encode(job)

if job["removeOnComplete"] == true then
  redis.call("HDEL", jobsKey, jobId)
  if groupMapKey and groupMapKey ~= "" then
    redis.call("HDEL", groupMapKey, jobId)
  end
else
  redis.call("HSET", jobsKey, jobId, updated)
end

local idempotency = job["idempotencyKey"]
if idempKey and idempKey ~= "" and type(idempotency) == "string" and idempotency ~= "" then
  if job["removeOnComplete"] == true or pruneIdempotency == "1" then
    redis.call("HDEL", idempKey, idempotency)
  end
end

return updated
`.trim();

/**
 * Atomically increments `attemptsMade`, records failure metadata, clears active
 * lease, and either requeues the job (delayed or immediate waiting) or moves it
 * to the Dead-Letter Queue (DLQ) / failed state.
 *
 * KEYS[1]: jobs hash
 * KEYS[2]: active zset
 * KEYS[3]: leases hash
 * KEYS[4]: stalled hash
 * KEYS[5]: waiting zset
 * KEYS[6]: delayed zset
 * KEYS[7]: dlq list
 * KEYS[8]: failed counter
 * KEYS[9]: seq string counter
 * KEYS[10]: idempotency hash (optional)
 *
 * ARGV[1]: jobId
 * ARGV[2]: errorMessage
 * ARGV[3]: errorStack
 * ARGV[4]: now (epoch ms)
 * ARGV[5]: retryAt (epoch ms string, or empty string if no retry)
 * ARGV[6]: forceDlq ("1" | "0")
 * ARGV[7]: expectedToken (empty string to skip token check)
 * ARGV[8]: pruneIdempotency ("1" | "0", optional)
 *
 * Returns: { nextStatus, updatedJobJson } or nil if missing / lease mismatch.
 */
export const LUA_NACK_OR_DLQ_JOB = `
local jobsKey = KEYS[1]
local activeKey = KEYS[2]
local leasesKey = KEYS[3]
local stalledKey = KEYS[4]
local waitingKey = KEYS[5]
local delayedKey = KEYS[6]
local dlqKey = KEYS[7]
local failedKey = KEYS[8]
local seqKey = KEYS[9]
local idempKey = KEYS[10]
local groupActiveKey = KEYS[11]

local jobId = ARGV[1]
local errorMessage = ARGV[2] or "Job failed"
local errorStack = ARGV[3] or errorMessage
local now = tonumber(ARGV[4]) or 0
local retryAtRaw = ARGV[5] or ""
local forceDlq = ARGV[6] or "0"
local expectedToken = ARGV[7] or ""
local pruneIdempotency = ARGV[8] or "0"

if expectedToken ~= "" then
  local currentToken = redis.call("HGET", leasesKey, jobId)
  if not currentToken or currentToken ~= expectedToken then
    return nil
  end
end

local wasActive = redis.call("ZREM", activeKey, jobId)
redis.call("ZREM", delayedKey, jobId)
redis.call("ZREM", waitingKey, jobId)
redis.call("HDEL", leasesKey, jobId)

local raw = redis.call("HGET", jobsKey, jobId)
if not raw then
  return nil
end

local job = cjson.decode(raw)
local gid = job["groupId"]
if wasActive > 0 and groupActiveKey and groupActiveKey ~= "" and type(gid) == "string" and gid ~= "" then
  if redis.call("HEXISTS", groupActiveKey, gid) == 1 then
    local rem = redis.call("HINCRBY", groupActiveKey, gid, -1)
    if rem <= 0 then
      redis.call("HDEL", groupActiveKey, gid)
    end
  end
end
local attemptsMade = (tonumber(job["attemptsMade"]) or 0) + 1
local maxAttempts = tonumber(job["maxAttempts"]) or 1
job["attemptsMade"] = attemptsMade
job["failedReason"] = errorMessage
job["leaseToken"] = nil
job["leaseExpiresAt"] = nil

local stack = job["stacktrace"]
if type(stack) ~= "table" then
  stack = {}
end
table.insert(stack, errorStack)
job["stacktrace"] = stack

local moveToDlq = (forceDlq == "1") or (retryAtRaw == "" and attemptsMade >= maxAttempts)

local function maybePruneIdempotency()
  local idempotency = job["idempotencyKey"]
  if pruneIdempotency == "1" and idempKey and idempKey ~= "" and type(idempotency) == "string" and idempotency ~= "" then
    redis.call("HDEL", idempKey, idempotency)
  end
end

if moveToDlq then
  redis.call("HDEL", stalledKey, jobId)
  job["status"] = "dead-letter"
  job["finishedAt"] = now
  redis.call("INCR", failedKey)
  local updated = cjson.encode(job)
  redis.call("HSET", jobsKey, jobId, updated)
  redis.call("RPUSH", dlqKey, jobId)
  maybePruneIdempotency()
  return { "dead-letter", updated }
end

if retryAtRaw ~= "" then
  local retryAt = tonumber(retryAtRaw) or now
  job["processAfter"] = retryAt
  if retryAt > now then
    job["status"] = "delayed"
    local updated = cjson.encode(job)
    redis.call("HSET", jobsKey, jobId, updated)
    redis.call("ZADD", delayedKey, retryAt, jobId)
    return { "delayed", updated }
  else
    job["status"] = "waiting"
    local updated = cjson.encode(job)
    redis.call("HSET", jobsKey, jobId, updated)
    local seq = redis.call("INCR", seqKey)
    local prio = tonumber(job["priority"]) or 0
    local score = (-prio * 1000000000) + seq
    redis.call("ZADD", waitingKey, score, jobId)
    return { "waiting", updated }
  end
end

redis.call("HDEL", stalledKey, jobId)
job["status"] = "failed"
job["finishedAt"] = now
redis.call("INCR", failedKey)
local updated = cjson.encode(job)
redis.call("HSET", jobsKey, jobId, updated)
maybePruneIdempotency()
return { "failed", updated }
`.trim();

/**
 * Atomically extends an active job's lease expiration timestamp if and only if
 * the caller still owns the matching lease token.
 *
 * KEYS[1]: jobs hash
 * KEYS[2]: active zset
 * KEYS[3]: leases hash
 *
 * ARGV[1]: jobId
 * ARGV[2]: leaseToken
 * ARGV[3]: now (epoch ms)
 * ARGV[4]: lockDurationMs
 *
 * Returns: 1 if lease was renewed, 0 otherwise.
 */
export const LUA_RENEW_LEASE = `
local jobsKey = KEYS[1]
local activeKey = KEYS[2]
local leasesKey = KEYS[3]

local jobId = ARGV[1]
local token = ARGV[2]
local now = tonumber(ARGV[3]) or 0
local lockDurationMs = tonumber(ARGV[4]) or 30000

local currentToken = redis.call("HGET", leasesKey, jobId)
if not currentToken or currentToken ~= token then
  return 0
end

local newExpiry = now + lockDurationMs
redis.call("ZADD", activeKey, newExpiry, jobId)

local raw = redis.call("HGET", jobsKey, jobId)
if raw then
  local job = cjson.decode(raw)
  job["leaseExpiresAt"] = newExpiry
  local stack = job["stacktrace"]
  if type(stack) ~= "table" then
    stack = {}
    job["stacktrace"] = stack
  end
  if next(stack) == nil and cjson.empty_array_mt then
    setmetatable(stack, cjson.empty_array_mt)
  end
  redis.call("HSET", jobsKey, jobId, cjson.encode(job))
end

return 1
`.trim();

/**
 * Atomically discovers active jobs whose leases expired at or before `now`,
 * increments each job's stalled counter, and either requeues it into `waiting`
 * or moves it to the Dead-Letter Queue once `stalledCount > maxStalledCount`.
 *
 * KEYS[1]: jobs hash
 * KEYS[2]: active zset
 * KEYS[3]: leases hash
 * KEYS[4]: stalled hash
 * KEYS[5]: waiting zset
 * KEYS[6]: dlq list
 * KEYS[7]: failed counter
 * KEYS[8]: seq string counter
 * KEYS[9]: idempotency hash (optional)
 *
 * ARGV[1]: now (epoch ms)
 * ARGV[2]: maxStalledCount
 * ARGV[3]: pruneIdempotency ("1" | "0", optional)
 *
 * Returns: { reclaimedJobJsons[], deadLetteredJobJsons[] }
 */
export const LUA_RECLAIM_STALLED = `
local jobsKey = KEYS[1]
local activeKey = KEYS[2]
local leasesKey = KEYS[3]
local stalledKey = KEYS[4]
local waitingKey = KEYS[5]
local dlqKey = KEYS[6]
local failedKey = KEYS[7]
local seqKey = KEYS[8]
local idempKey = KEYS[9]
local groupActiveKey = KEYS[10]

local now = tonumber(ARGV[1]) or 0
local maxStalledCount = tonumber(ARGV[2]) or 1
local pruneIdempotency = ARGV[3] or "0"

local expiredIds = redis.call("ZRANGEBYSCORE", activeKey, "-inf", now)
local reclaimed = {}
local deadLettered = {}

for i = 1, #expiredIds do
  local jobId = expiredIds[i]
  local wasActive = redis.call("ZREM", activeKey, jobId)
  redis.call("HDEL", leasesKey, jobId)
  local raw = redis.call("HGET", jobsKey, jobId)
  if raw then
    local job = cjson.decode(raw)
    local gid = job["groupId"]
    if wasActive > 0 and groupActiveKey and groupActiveKey ~= "" and type(gid) == "string" and gid ~= "" then
      if redis.call("HEXISTS", groupActiveKey, gid) == 1 then
        local rem = redis.call("HINCRBY", groupActiveKey, gid, -1)
        if rem <= 0 then
          redis.call("HDEL", groupActiveKey, gid)
        end
      end
    end
    local stalled = redis.call("HINCRBY", stalledKey, jobId, 1)
    job["stalledCount"] = stalled
    job["leaseToken"] = nil
    job["leaseExpiresAt"] = nil

    if stalled > maxStalledCount then
      redis.call("HDEL", stalledKey, jobId)
      local reason = "Job stalled more than maxStalledCount (" .. tostring(maxStalledCount) .. ")"
      job["status"] = "dead-letter"
      job["failedReason"] = reason
      job["finishedAt"] = now
      local stack = job["stacktrace"]
      if type(stack) ~= "table" then
        stack = {}
      end
      table.insert(stack, reason)
      job["stacktrace"] = stack
      redis.call("INCR", failedKey)
      local updated = cjson.encode(job)
      redis.call("HSET", jobsKey, jobId, updated)
      redis.call("RPUSH", dlqKey, jobId)
      local idempotency = job["idempotencyKey"]
      if pruneIdempotency == "1" and idempKey and idempKey ~= "" and type(idempotency) == "string" and idempotency ~= "" then
        redis.call("HDEL", idempKey, idempotency)
      end
      table.insert(deadLettered, updated)
    else
      job["status"] = "waiting"
      job["startedAt"] = nil
      job["processAfter"] = now
      local stack = job["stacktrace"]
      if type(stack) ~= "table" then
        stack = {}
        job["stacktrace"] = stack
      end
      if next(stack) == nil and cjson.empty_array_mt then
        setmetatable(stack, cjson.empty_array_mt)
      end
      local updated = cjson.encode(job)
      redis.call("HSET", jobsKey, jobId, updated)
      local seq = redis.call("INCR", seqKey)
      local prio = tonumber(job["priority"]) or 0
      local score = (-prio * 1000000000) + seq
      redis.call("ZADD", waitingKey, score, jobId)
      table.insert(reclaimed, updated)
    end
  end
end

return { reclaimed, deadLettered }
`.trim();
