import { z } from 'zod';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { interventionResultSchema } from './intervention-output.mjs';
const entry=z.object({seq:z.number().int(),time:z.number(),type:z.string(),role:z.enum(['user','assistant','context']),text:z.string(),source:z.json()});
const node=z.object({id:z.string(),role:z.enum(['user','assistant','context']),seqs:z.array(z.number().int()),startedAt:z.number(),endedAt:z.number(),toolCount:z.number(),summary:z.string().max(180),details:z.array(z.string().max(240)).max(3)});
export const reportSchema=z.object({sessionId:z.string(),snapshotId:z.string(),jobId:z.string().optional(),generatedAt:z.number(),route:z.object({provider:z.string(),model:z.string()}),nodes:z.array(node),entries:z.array(entry)});
const checkpointSchema=z.object({jobId:z.string(),sessionId:z.string(),snapshotId:z.string(),route:z.object({provider:z.string(),model:z.string()}),analysisVersion:z.string(),updatedAt:z.number(),cache:z.record(z.string(),z.array(z.object({id:z.string(),summary:z.string().max(180),details:z.array(z.string().max(240)).max(3)})))});
const route=z.object({provider:z.string(),model:z.string()});
const readEvidence=z.array(z.object({seq:z.number().int(),offset:z.number().int().nonnegative(),totalChars:z.number().int().nonnegative(),text:z.string()}));
const coverage=z.object({readChars:z.number().int().nonnegative(),totalChars:z.number().int().nonnegative(),readEntries:z.number().int().nonnegative(),totalEntries:z.number().int().nonnegative(),complete:z.boolean(),rounds:z.number().int().nonnegative(),budgetExhausted:z.boolean(),ranges:z.array(z.object({seq:z.number().int(),start:z.number().int().nonnegative(),end:z.number().int().nonnegative(),totalChars:z.number().int().nonnegative()}))});
const interactionSource=z.object({sessionId:z.string(),snapshotId:z.string(),entries:z.array(entry)});
const interactionVersion=z.object({resultId:z.string(),sessionId:z.string(),interactionId:z.string(),humanSeq:z.number().int(),sourceSnapshotId:z.string(),basisHash:z.string(),analysisVersion:z.string(),generatedAt:z.number(),route,result:interventionResultSchema,readEvidence,coverage});
const daySummary=z.object({date:z.string(),timeZone:z.string(),includeArchived:z.boolean(),text:z.string().min(1).max(903),generatedAt:z.number(),route,sourceSessionId:z.string(),sourceFingerprint:z.string(),sessionCount:z.number().int().nonnegative(),humanCount:z.number().int().nonnegative(),sources:z.array(z.object({sessionId:z.string(),title:z.string(),workspaceId:z.string(),workspaceTitle:z.string(),humanSeqs:z.array(z.number().int())})),input:z.json()});
const schedule = z.object({
  enabled: z.boolean(),
  time: z.string(),
  timeZone: z.string(),
  firstEligibleDate: z.string(),
  lastRun: z.object({
    date: z.string(), at: z.number(), message: z.string(),
    status: z.enum(['waiting', 'running', 'completed', 'skipped', 'failed', 'interrupted']),
  }).nullable(),
});
const replayCase=z.object({
  id:z.string(),favorite:z.boolean(),savedAt:z.number(),
  humans:z.array(z.object({seq:z.number(),time:z.number().nullable(),text:z.string()})),
  cues:z.array(z.json()),route:route.nullable(),workspacePath:z.string().nullable(),scene:z.json().nullable(),
});
export const journalSpec=defineDomain({name:'dsh_collab_journal',version:1,tables:{reports:domainTable(reportSchema),versions:domainTable(reportSchema),checkpoints:domainTable(checkpointSchema),interaction_sources:domainTable(interactionSource),interaction_versions:domainTable(interactionVersion),interaction_latest:domainTable(z.object({resultId:z.string()})),day_summaries:domainTable(daySummary),replay_cases:domainTable(replayCase),replay_results:domainTable(z.object({run:z.json().nullable(),previous:z.json().nullable()})),schedule:domainTable(schedule)}});
