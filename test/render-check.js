/**
 * test/render-check.js — 校验服务端 Markdown 渲染结构
 * 用法：node test/render-check.js
 */
'use strict';

async function main() {
  const res = await fetch('http://127.0.0.1:8787/blog/lemon-squeezy-first-order');
  const t = await res.text();
  const count = (re) => (t.match(re) || []).length;
  const checks = [
    ['博客页 h2 标题数 >= 3', count(/<h2/g) >= 3, count(/<h2/g)],
    ['代码块数 == 1', count(/<pre>/g) === 1, count(/<pre>/g)],
    ['列表项数 >= 6', count(/<li>/g) >= 6, count(/<li>/g)],
    ['链接数 >= 5', count(/<a /g) >= 5, count(/<a /g)],
    ['粗体渲染', t.includes('<strong>'), '-'],
    ['代码行渲染', t.includes('<code>'), '-'],
  ];
  const res2 = await fetch('http://127.0.0.1:8787/docs/quickstart');
  const d = await res2.text();
  checks.push(['文档页 h2 标题数 >= 2', (d.match(/<h2/g) || []).length >= 2, (d.match(/<h2/g) || []).length]);
  checks.push(['文档页表格渲染', d.includes('<table'), '-']);

  /* 法律页面「内容」检查：防止路由缺失导致回退成首页内容 */
  const HOMEPAGE_MARK = '从想法到海外收款';
  const tos = await (await fetch('http://127.0.0.1:8787/terms')).text();
  checks.push(['服务条款页含实质条款', 
    tos.includes('退款政策') && tos.includes('免责声明') && tos.includes('责任限制') && tos.includes('第 16 条') && !tos.includes(HOMEPAGE_MARK),
    tos.includes(HOMEPAGE_MARK) ? '回退成了首页内容' : `${tos.length} 字符`]);
  const pp = await (await fetch('http://127.0.0.1:8787/privacy')).text();
  checks.push(['隐私政策页含实质条款',
    pp.includes('我们收集的个人信息') && pp.includes('您的数据权利') && pp.includes('保留期限') && pp.includes('Waffo Pancake') && !pp.includes(HOMEPAGE_MARK),
    pp.includes(HOMEPAGE_MARK) ? '回退成了首页内容' : `${pp.length} 字符`]);

  let fail = 0;
  for (const [name, ok, extra] of checks) {
    console.log(`  ${ok ? '✅' : '❌'} ${name}${ok ? '' : '（实际 ' + extra + '）'}`);
    if (!ok) fail++;
  }
  console.log(fail ? '\n渲染检查失败' : '\n渲染检查全部通过');
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
