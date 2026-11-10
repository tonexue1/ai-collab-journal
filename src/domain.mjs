import { z } from 'zod';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
const entry=z.object({seq:z.number().int(),time:z.number(),type:z.string(),role:z.enum(['user','assistant','context']),text:z.string(),source:z.json()});
const node=z.object({id:z.string(),role:z.enum(['user','assistant','context']),seqs:z.array(z.number().int()),startedAt:z.number(),endedAt:z.number(),toolCount:z.number(),summary:z.string().max(180),details:z.array(z.string().max(240)).max(3)});
export const reportSchema=z.object({sessionId:z.string(),snapshotId:z.string(),generatedAt:z.number(),route:z.object({provider:z.string(),model:z.string()}),nodes:z.array(node),entries:z.array(entry)});
export const journalSpec=defineDomain({name:'dsh_collab_journal',version:1,tables:{reports:domainTable(reportSchema),versions:domainTable(reportSchema)}});
