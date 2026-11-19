import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 测试副作用模块：必须最先 import，把网络诊断日志重定向到临时目录，避免写进真实 ~/.dsh/logs。
if (!process.env.DSH_AU_NET_LOG) {
  process.env.DSH_AU_NET_LOG = join(mkdtempSync(join(tmpdir(), 'dsh-au-test-netlog-')), 'net.jsonl');
}
