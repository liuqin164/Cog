export interface Fact {
  id: string;
  text: string;
}

export interface Scenario {
  id: string;
  kind: 'positive' | 'negative';
  cue: string;
  target?: string;
  forbidden: string[];
}

export const FACTS: Fact[] = [
  { id: 't01', text: '我对花生过敏，吃坚果类零食会起疹子。' },
  { id: 't02', text: '我的车是一辆白色丰田卡罗拉，车牌尾号 7321。' },
  { id: 't03', text: '老板周五通常不在办公室，重要签字要提前。' },
  { id: 't04', text: '家里的路由器放在玄关柜子最上层，重启要先拔电源。' },
  { id: 't05', text: '我习惯早上七点喝一杯黑咖啡，不加糖。' },
  { id: 't06', text: '我下个月要参加姐姐的婚礼，需要准备一套深色西装。' },
  { id: 't07', text: '我家的猫叫团子，对鸡肉罐头不感兴趣。' },
  { id: 't08', text: '我对乳糖不耐受，喝牛奶会肚子疼。' },
  { id: 't09', text: '我的工位在 12 楼东侧靠窗，门禁卡经常失灵。' },
  { id: 't10', text: '我每周三晚上去游泳馆上课，教练姓周。' },
  { id: 't11', text: '我的租房合同到明年三月到期，房东说要提前两个月谈续租。' },
  { id: 't12', text: '我在做一个叫青岚的内部项目，主要用 Rust 写。' },
  { id: 't13', text: '我妈妈对百合花粉过敏，家里不能摆百合。' },
  { id: 't14', text: '我的医保卡放在书房第二个抽屉的蓝色文件袋里。' },
  { id: 't15', text: '我晚上十一点后不吃东西，胃会反酸。' },
  { id: 't16', text: '我用的洗发水是无硅油的，头皮容易出油。' },
  { id: 'd01', text: '我的通勤路线是坐地铁 4 号线到科技园站，再走十分钟。' },
  { id: 'd02', text: '团队周会固定在周一上午十点，用线上会议。' },
  { id: 'd03', text: '我的备用手机号只用于收快递，尾号 5566。' },
  { id: 'd04', text: '公司报销系统要求发票在当月 25 日前提交。' },
  { id: 'd05', text: '我常去的健身房在小区北门，月卡 299 元。' },
  { id: 'd06', text: '我的工资卡是招商银行，每月 15 号发薪。' },
  { id: 'd07', text: '家里冰箱的冷冻层第二格放着速冻饺子。' },
  { id: 'd08', text: '我习惯用 0.5 毫米的黑色中性笔做笔记。' },
  { id: 'd09', text: '我的常用邮箱是 qin.work@example.com。' },
  { id: 'd10', text: '出差住宿标准是每晚不超过 500 元。' },
  { id: 'd11', text: '我每周六上午去菜市场买一周的蔬菜。' },
  { id: 'd12', text: '我的自行车是折叠款，放在阳台右侧。' },
  { id: 'd13', text: '家里 Wi-Fi 名称是 QingLan-5G，密码贴在冰箱上。' },
  { id: 'd14', text: '我常用的云盘是 OneDrive，工作文件放在 Projects 目录。' },
  { id: 'd15', text: '我喝不惯气泡水，觉得太刺激。' },
  { id: 'd16', text: '我的眼镜度数是左眼 350、右眼 325。' },
  { id: 'd17', text: '公司楼下那家面馆只在工作日中午营业。' },
  { id: 'd18', text: '我的 Kindle 里存着十几本没看完的历史书。' },
  { id: 'd19', text: '我睡觉前会把手机调成飞行模式。' },
  { id: 'd20', text: '我常用的洗衣液是薰衣草味的。' },
  { id: 'd21', text: '我每周给父母打一次视频电话，通常在周日晚上。' },
  { id: 'd22', text: '我办公桌上有一盆绿萝，需要每周浇一次水。' },
  { id: 'd23', text: '我的护照有效期到 2029 年 6 月。' },
  { id: 'd24', text: '我每天午饭后会散步十五分钟。' },
];

export const SCENARIOS: Scenario[] = [
  { id: 's01', kind: 'positive', target: 't01', cue: '周五团队聚餐订餐厅，有没有需要提前跟店家说明的？', forbidden: ['花生', '过敏', '疹子', '坚果'] },
  { id: 's02', kind: 'positive', target: 't02', cue: '停车场登记表要填车辆信息，我该写哪些？', forbidden: ['丰田', '卡罗拉', '车牌', '7321', '白色'] },
  { id: 's03', kind: 'positive', target: 't03', cue: '这周想找负责人批报销，什么时候去比较稳妥？', forbidden: ['老板', '签字', '周五', '办公室'] },
  { id: 's04', kind: 'positive', target: 't04', cue: '家里网又断了，第一步该动哪里？', forbidden: ['路由器', '玄关', '电源', '重启'] },
  { id: 's05', kind: 'positive', target: 't05', cue: '帮我安排一下起床后的流程。', forbidden: ['咖啡', '七点', '糖'] },
  { id: 's06', kind: 'positive', target: 't06', cue: '最近有什么需要提前置办的行头吗？', forbidden: ['婚礼', '西装', '姐姐', '深色'] },
  { id: 's07', kind: 'positive', target: 't07', cue: '网购宠物用品时该避开什么口味？', forbidden: ['猫', '团子', '鸡肉', '罐头'] },
  { id: 's08', kind: 'positive', target: 't08', cue: '早餐店点单有什么要提醒我的？', forbidden: ['乳糖', '牛奶', '肚子', '疼'] },
  { id: 's09', kind: 'positive', target: 't09', cue: '明天去公司，进楼和找座位要注意什么？', forbidden: ['工位', '12', '东侧', '靠窗', '门禁卡'] },
  { id: 's10', kind: 'positive', target: 't10', cue: '帮我看看哪天晚上已经有安排了。', forbidden: ['周三', '游泳', '教练', '姓周'] },
  { id: 's11', kind: 'positive', target: 't11', cue: '有什么时间点需要提前标记的吗？', forbidden: ['租房', '合同', '三月', '房东', '续租'] },
  { id: 's12', kind: 'positive', target: 't12', cue: '写周报时该把哪项工作放在最前面？', forbidden: ['青岚', 'Rust', '项目'] },
  { id: 's13', kind: 'positive', target: 't13', cue: '过节买花回家有什么禁忌？', forbidden: ['妈妈', '百合', '花粉', '过敏'] },
  { id: 's14', kind: 'positive', target: 't14', cue: '去医院前要带的东西放哪了？', forbidden: ['医保卡', '书房', '抽屉', '蓝色'] },
  { id: 's15', kind: 'positive', target: 't15', cue: '夜里饿了想吃点东西，有什么要留意的？', forbidden: ['十一点', '反酸', '胃'] },
  { id: 's16', kind: 'positive', target: 't16', cue: '日用品快用完了，补货时怎么选？', forbidden: ['洗发水', '无硅油', '头皮'] },
  { id: 's17', kind: 'negative', cue: '帮我把这份季度报表的公式检查一遍。', forbidden: [] },
  { id: 's18', kind: 'negative', cue: '明天天气怎么样，适合出门跑步吗？', forbidden: [] },
  { id: 's19', kind: 'negative', cue: '给我讲一个关于海盗的短故事。', forbidden: [] },
  { id: 's20', kind: 'negative', cue: '把这段英文翻译成日文。', forbidden: [] },
  { id: 's21', kind: 'negative', cue: '推荐一部适合周末看的科幻电影。', forbidden: [] },
  { id: 's22', kind: 'negative', cue: '这个 SQL 查询为什么返回空结果？', forbidden: [] },
  { id: 's23', kind: 'negative', cue: '帮我写一封感谢同事帮忙的邮件。', forbidden: [] },
  { id: 's24', kind: 'negative', cue: '解释一下什么是光合作用。', forbidden: [] },
];

export function validateCorpus(): void {
  const ids = new Set(FACTS.map((fact) => fact.id));
  if (ids.size !== FACTS.length) throw new Error('corpus: duplicate fact id');
  const targets = SCENARIOS.filter((scenario) => scenario.kind === 'positive').map((scenario) => scenario.target);
  if (new Set(targets).size !== targets.length) throw new Error('corpus: a target is reused');
  for (const scenario of SCENARIOS) {
    if (scenario.kind === 'positive' && (!scenario.target || !ids.has(scenario.target))) {
      throw new Error(`corpus: ${scenario.id} has no valid target`);
    }
    const target = scenario.target ? FACTS.find((fact) => fact.id === scenario.target) : undefined;
    for (const term of scenario.forbidden) {
      if (!target?.text.includes(term)) throw new Error(`corpus: ${scenario.id} forbidden term ${term} is not in the target`);
      if (scenario.cue.includes(term)) throw new Error(`corpus: ${scenario.id} cue names ${term}`);
    }
  }
}
