-- SRVW-113: additive enum value so a workflow can trigger on a job entering
-- a specific sub-status.
ALTER TYPE "AutomationTriggerType" ADD VALUE IF NOT EXISTS 'JOB_SUB_STATUS_ENTERED';
