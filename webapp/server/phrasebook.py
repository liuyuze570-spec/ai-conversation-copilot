"""常用语与术语库：人工整理的高频句子 / 单词，翻译链的第一路。

为什么需要这一层
----------------
本地 Opus-MT 是通用小模型，对**极短输入**和**拼写变体**会退化。实测（量化权重）：

    hello          -> 哈哈哈哈哈哈哈哈哈
    Good morning   -> 早早早早早
    hi             -> hi hi hi
    hellow         -> 地狱          # hello 的手误，被切成 hell + ow

这不是「模型不够大」能解释的 —— 短句没有上下文，模型靠先验乱猜，而重复是最省事的
出路。对听障使用者来说，"hellow → 地狱" 是直接误导，比不翻译更糟。

所以第一路永远是这张表：命中就直接给人工写好的译文，`mode="phrasebook"`，
界面标「常用语库（人工整理）」，既不冒充模型，也不让模型碰这些句子。

设计约束
--------
1. **只做精确匹配**（归一化后）。不做「包含」或模糊匹配 —— 长句里夹一个 hello
   就走模型，避免把整句硬套成短语译文。
2. **拼写变体只用于查表，不改写原文**。用户看到的永远是他打的那句话。
3. 命中时 `elapsed_ms` 是真的（虽然接近 0），仍然计入用量统计。
4. 这张表**可以**继续加，但加了必须能说清「这句中文是谁写的、有没有核对过」。
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# ---------------------------------------------------------------- 拼写归一

#: 常见手误 / 网络缩写 / 变体 → 标准写法。
#: 只收**不会造成歧义**的：`its`（its / it's）这类有歧义的一律不收。
SPELL_FIX: dict[str, str] = {
    # 手误（多一个字母、少一个字母、邻键）
    "hellow": "hello",
    "hellp": "hello",
    "helo": "hello",
    "heelo": "hello",
    "hii": "hi",
    "hiii": "hi",
    "thnks": "thanks",
    "thansk": "thanks",
    "thankyou": "thank you",
    "thx": "thanks",
    "tnx": "thanks",
    "pls": "please",
    "plz": "please",
    "pleas": "please",
    "sory": "sorry",
    "sorrry": "sorry",
    "welcomee": "welcome",
    "byee": "bye",
    "okey": "okay",
    "okey dokey": "okay",
    "gud": "good",
    "goood": "good",
    "morining": "morning",
    "moring": "morning",
    "nigth": "night",
    "tommorow": "tomorrow",
    "tomorow": "tomorrow",
    "tommorrow": "tomorrow",
    "yes": "yes",
    "yep": "yes",
    "yeah": "yes",
    "yup": "yes",
    "nope": "no",
    "nah": "no",
    # 网络缩写（整词才换）
    "u": "you",
    "ur": "your",
    "r": "are",
    "ya": "you",
    "im": "i am",
    "ive": "i have",
    "dont": "do not",
    "doesnt": "does not",
    "didnt": "did not",
    "cant": "cannot",
    "couldnt": "could not",
    "wouldnt": "would not",
    "shouldnt": "should not",
    "isnt": "is not",
    "arent": "are not",
    "wasnt": "was not",
    "werent": "were not",
    "wont": "will not",
    "havent": "have not",
    "hasnt": "has not",
    "whats": "what is",
    "thats": "that is",
    "howre": "how are",
    "wat": "what",
    "wut": "what",
    "becuz": "because",
    "bcz": "because",
    "coz": "because",
    "cuz": "because",
    "tho": "though",
    "thru": "through",
    "nite": "night",
    "goin": "going",
    "comin": "coming",
    "lemme": "let me",
    "gimme": "give me",
    "dunno": "i do not know",
    "gonna": "going to",
    "wanna": "want to",
    "gotta": "got to",
    "kinda": "kind of",
}

_PUNCT = re.compile(r"[^\w\s']+", re.UNICODE)
_SPACE = re.compile(r"\s+")

#: `cannot` 展开后句子里的 `not` 单独成词；查表时统一按单个空格。
_CONTRACTIONS = {
    "cannot": "can not",
}


def normalize(text: str) -> str:
    """把一句话压成查表用的键：小写、去标点、修正手误、单空格。

    只用于查表。原文该怎么显示仍然怎么显示 —— 用户打错字是他的事，
    我们不能悄悄改掉他提交的句子。
    """
    value = (text or "").strip().lower()
    # 弯引号统一，避免 `don’t` 与 `don't` 查不到同一条
    value = value.replace("\u2019", "'").replace("\u2018", "'")
    value = _PUNCT.sub(" ", value)
    value = _SPACE.sub(" ", value).strip()
    value = _CONTRACTIONS.get(value, value)
    if not value:
        return ""
    words = []
    for word in value.split(" "):
        fixed = SPELL_FIX.get(word, word)
        words.append(fixed)
    out = " ".join(words)
    # 单次替换可能产生新的组合（`gonna` → `going to`），再归一一次空格即可；
    # 不再二次套 SPELL_FIX，避免链式改写越走越远。
    return _SPACE.sub(" ", out).strip()


# ---------------------------------------------------------------- 句子库
#
# 分组只为方便维护，查表时不看分组。中文译法以「听障使用者一眼能懂」为准：
# 不追求书面雅致，追求短、直、没有歧义。

SENTENCES: dict[str, str] = {
    # ---- 问候与寒暄 ----
    "hello": "你好",
    "hi": "嗨，你好",
    "hey": "嘿",
    "good morning": "早上好",
    "good afternoon": "下午好",
    "good evening": "晚上好",
    "good night": "晚安",
    "how are you": "你好吗",
    "how are you doing": "你最近怎么样",
    "how is it going": "最近怎么样",
    "how have you been": "你最近过得怎么样",
    "how is everything": "一切都好吗",
    "what is up": "最近怎么样",
    "what is new": "有什么新鲜事吗",
    "i am fine thanks": "我很好，谢谢",
    "i am good thanks": "我挺好，谢谢",
    "i am fine": "我很好",
    "i am good": "我挺好",
    "not bad": "还不错",
    "pretty good": "挺好的",
    "so so": "一般般",
    "nice to meet you": "很高兴认识你",
    "nice to see you": "很高兴见到你",
    "nice to see you again": "很高兴又见到你",
    "long time no see": "好久不见",
    "good to see you": "见到你真好",
    "thank you": "谢谢",
    "thanks": "谢谢",
    "thanks a lot": "非常感谢",
    "thank you so much": "太感谢你了",
    "thank you very much": "非常感谢你",
    "you are welcome": "不客气",
    "no problem": "没问题",
    "no worries": "别担心",
    "my pleasure": "乐意效劳",
    "sorry": "对不起",
    "i am sorry": "对不起",
    "i am so sorry": "真的很抱歉",
    "excuse me": "打扰一下",
    "pardon": "请再说一遍",
    "pardon me": "不好意思",
    "never mind": "没关系",
    "it is okay": "没关系",
    "that is okay": "没关系",
    "goodbye": "再见",
    "bye": "再见",
    "see you": "回头见",
    "see you soon": "回头见",
    "see you tomorrow": "明天见",
    "see you later": "待会儿见",
    "see you next week": "下周见",
    "take care": "保重",
    "have a nice day": "祝你今天愉快",
    "have a good day": "祝你今天愉快",
    "have a good weekend": "周末愉快",
    "good luck": "祝你好运",
    "congratulations": "恭喜",
    "cheers": "干杯",
    "happy birthday": "生日快乐",
    "happy new year": "新年快乐",
    "merry christmas": "圣诞快乐",
    "welcome": "欢迎",
    "please": "请",
    "of course": "当然",
    "sure": "当然",
    "certainly": "当然可以",
    "absolutely": "完全没问题",
    "i think so": "我想是这样",
    "i do not think so": "我不这么认为",
    "i hope so": "希望如此",
    "i agree": "我同意",
    "i do not agree": "我不同意",
    "you are right": "你说得对",
    "you are wrong": "你错了",
    "that is right": "对",
    "that is correct": "没错",
    "that is wrong": "那不对",
    "no": "不",
    "yes": "是",
    "maybe": "也许吧",
    "i do not know": "我不知道",
    "i have no idea": "我不知道",
    "no idea": "不知道",
    "it depends": "看情况",
    "whatever": "随便吧",
    "fair enough": "有道理",
    "makes sense": "有道理",
    "sounds good": "听起来不错",
    "that sounds great": "听起来很棒",
    "that works for me": "我可以",
    "that does not work for me": "我不行",
    "let me think": "让我想想",
    "let me see": "让我看看",
    "hold on": "等一下",
    "wait a minute": "等一下",
    "just a moment": "请稍等",
    "one moment please": "请稍等",
    "what do you mean": "你什么意思",
    "what does that mean": "那是什么意思",
    "what does it mean": "这是什么意思",
    "what happened": "发生什么了",
    "what is going on": "怎么回事",
    "what is the matter": "怎么了",
    "what is wrong": "怎么了",
    "are you okay": "你还好吗",
    "are you all right": "你没事吧",
    "are you sure": "你确定吗",
    "are you serious": "你是认真的吗",
    "are you kidding": "你在开玩笑吧",
    "are you kidding me": "你在开玩笑吗",
    "just kidding": "开个玩笑",
    "i am serious": "我是认真的",
    "i am not sure": "我不确定",
    "i am sure": "我确定",
    "i am ready": "我准备好了",
    "i am busy": "我很忙",
    "i am free": "我有空",
    "i am tired": "我累了",
    "i am hungry": "我饿了",
    "i am thirsty": "我渴了",
    "i am lost": "我迷路了",
    "i am late": "我迟到了",
    "i am on my way": "我在路上了",
    "i am coming": "我来了",
    "i am back": "我回来了",
    "i am here": "我到了",
    "do not worry": "别担心",
    "do not move": "别动",
    "take it easy": "放轻松",
    "calm down": "冷静点",
    "hurry up": "快点",
    "come on": "拜托",
    "watch out": "小心",
    "be careful": "小心",
    "let us go": "走吧",
    "let us start": "我们开始吧",
    "let us begin": "我们开始吧",
    "good job": "干得好",
    "well done": "做得好",
    "nice work": "干得漂亮",
    "that is great": "太好了",
    "that is good": "挺好的",
    "that is amazing": "太棒了",
    "that is awesome": "太棒了",
    "that is crazy": "太疯狂了",
    "that is terrible": "太糟糕了",
    "that is a pity": "真可惜",
    "that is too bad": "太可惜了",
    "i cannot believe it": "我真不敢相信",
    "no way": "不可能吧",
    "it does not matter": "没关系",
    "it is not a big deal": "没什么大不了的",
    "it is fine": "没事",
    "it is important": "这很重要",
    "it is possible": "有可能",
    "it is impossible": "不可能",
    "it is worth it": "值得",
    "what do you think": "你觉得呢",
    "what do you want": "你想要什么",
    "what are you doing": "你在干什么",
    "where are you": "你在哪",
    "where are you from": "你从哪里来",
    "how old are you": "你多大了",
    "how much": "多少",
    "how many": "多少个",
    "how long": "多久",
    "how far": "多远",
    "how often": "多久一次",
    "why not": "为什么不呢",
    # ---- 听不懂 / 沟通补救（听障场景最关键的一组）----
    "could you say that again": "你能再说一遍吗",
    "could you say that again please": "你能再说一遍吗",
    "can you say that again": "你能再说一遍吗",
    "can you say that again please": "你能再说一遍吗",
    "could you repeat that": "你能重复一遍吗",
    "could you repeat that please": "你能重复一遍吗",
    "can you repeat that": "你能重复一遍吗",
    "can you repeat that please": "你能重复一遍吗",
    "could you speak more slowly": "你能说慢一点吗",
    "could you speak a little slower": "你能说慢一点吗",
    "could you speak louder": "你能大声一点吗",
    "i do not understand": "我没听懂",
    "i did not understand": "我没听懂",
    "i did not catch that": "我没听清",
    "i did not hear you": "我没听见",
    "sorry i did not catch that": "抱歉，我没听清",
    "what did you say": "你说什么",
    "how do you spell that": "这个怎么拼",
    "how do you spell it": "这个怎么拼",
    "could you write it down": "你能写下来吗",
    "could you type it": "你能打字打出来吗",
    "could you send it in the chat": "你能发在聊天框里吗",
    "let me repeat that": "我重复一遍",
    "let me make sure i got that right": "我确认一下我没听错",
    "is that right": "对吗",
    "did i get that right": "我理解得对吗",
    "am i right": "我说得对吗",
    # ---- 时间 / 日程 / 会议 ----
    "what time": "几点",
    "what time is it": "现在几点",
    "when is it": "什么时候",
    "what day is it": "今天星期几",
    "what is the date": "今天几号",
    "i am running late": "我要迟到了",
    "i will be there in ten minutes": "我十分钟后到",
    "i will be there soon": "我马上到",
    "i will be right there": "我马上到",
    "can we reschedule": "我们能改时间吗",
    "can we change the time": "我们能改时间吗",
    "let us meet at three": "我们三点见",
    "let us meet tomorrow": "我们明天见",
    "let us meet tomorrow morning": "我们明天上午见",
    "the meeting is at three": "会议三点开始",
    "the meeting starts at three": "会议三点开始",
    "the meeting has been moved to friday": "会议改到周五了",
    "the meeting has been cancelled": "会议取消了",
    "the meeting is cancelled": "会议取消了",
    "i will call you back": "我给你回电话",
    "i will call you later": "我晚点给你打电话",
    "i will send you an email": "我给你发邮件",
    "i will text you": "我给你发消息",
    "please send me the details": "请把细节发给我",
    "let me check my schedule": "我看一下日程",
    "are you free tomorrow": "你明天有空吗",
    "are you available tomorrow": "你明天有空吗",
    "i am available": "我有空",
    "i am not available": "我没空",
    "i will be out of office": "我不在办公室",
    "see you at the meeting": "会上见",
    "the deadline is friday": "截止日期是周五",
    "the deadline is tomorrow": "截止日期是明天",
    "we need to push the deadline": "我们需要推迟截止日期",
    "we are running out of time": "我们时间不多了",
    "let us take a break": "我们休息一下",
    # ---- 金额 / 商务 / 合同 ----
    "how much is it": "多少钱",
    "how much does it cost": "这个多少钱",
    "how much is this": "这个多少钱",
    "that is too expensive": "太贵了",
    "that is cheap": "挺便宜的",
    "can you give me a discount": "能便宜点吗",
    "could you lower the price": "能降点价吗",
    "what is the total": "一共多少",
    "the total is fifty dollars": "一共五十美元",
    "please send me the invoice": "请把发票发给我",
    "could you confirm the price": "你能确认一下价格吗",
    "we are over budget": "我们超预算了",
    "we are within budget": "我们在预算内",
    "i will pay by card": "我刷卡",
    "i will pay in cash": "我付现金",
    "do you accept credit cards": "你们收信用卡吗",
    "can i get a receipt": "能给我一张收据吗",
    "that is not what we agreed": "这和我们说好的不一样",
    "the price went up": "涨价了",
    "the price is fixed": "价格是固定的",
    "we need your approval": "我们需要你的批准",
    "the contract is ready": "合同准备好了",
    "please sign here": "请在这里签字",
    "the payment is overdue": "款项逾期了",
    "we shipped the order yesterday": "我们昨天发了货",
    "the delivery is delayed": "交货延迟了",
    "i will send the proposal today": "我今天把方案发过去",
    "let us schedule a call": "我们约个电话",
    "please review the document": "请审阅这份文件",
    # ---- 会议现场（视频会议高频）----
    "let us get started": "我们开始吧",
    "let us go through the agenda": "我们过一遍议程",
    "could you share your screen": "你能共享屏幕吗",
    "you are on mute": "你静音了",
    "can you hear me": "你能听到我吗",
    "can you see my screen": "你能看到我的屏幕吗",
    "i cannot hear you": "我听不到你",
    "the connection is bad": "网络不好",
    "let us circle back later": "我们稍后再讨论",
    "that is out of scope": "那不在范围内",
    "i will follow up by email": "我会邮件跟进",
    "any questions": "有什么问题吗",
    "i have a question": "我有个问题",
    "could you explain that again": "你能再解释一遍吗",
    "could you give an example": "能举个例子吗",
    # ---- 看视频 / 影视对白 ----
    "what are you talking about": "你在说什么",
    "what do you want from me": "你想让我怎么样",
    "i do not care": "我不在乎",
    "i do not mind": "我不介意",
    "that is none of your business": "这不关你的事",
    "mind your own business": "管好你自己的事",
    "leave me alone": "别烦我",
    "get out": "出去",
    "shut up": "闭嘴",
    "come with me": "跟我来",
    "follow me": "跟我来",
    "give me a second": "给我一秒钟",
    "give me a break": "饶了我吧",
    "i told you so": "我早说过了",
    "i warned you": "我警告过你",
    "it is not my fault": "不是我的错",
    "it is your fault": "是你的错",
    "i am sorry about that": "那件事我很抱歉",
    "thank god": "谢天谢地",
    "oh my god": "我的天",
    "what the hell": "搞什么",
    "this is unbelievable": "这太难以置信了",
    "this is ridiculous": "这太荒唐了",
    "this is boring": "这很无聊",
    "this is interesting": "这挺有意思",
    "this is my favorite": "这是我最喜欢的",
    "i love it": "我很喜欢",
    "i hate it": "我讨厌这个",
    "i like it": "我喜欢",
    "i do not like it": "我不喜欢",
    "it looks good": "看起来不错",
    "it looks terrible": "看起来糟透了",
    "you look great": "你看起来很棒",
    "you look tired": "你看起来很累",
    "i miss you": "我想你",
    "i love you": "我爱你",
    "me too": "我也是",
    "so do i": "我也是",
    "neither do i": "我也不",
    "not yet": "还没有",
    "not now": "现在不行",
    "right now": "现在",
    "later": "以后再说",
    "soon": "很快",
    "almost": "差不多",
    "exactly": "正是",
    "definitely": "肯定",
    "probably": "可能",
    "of course not": "当然不是",
    "why": "为什么",
    "how come": "怎么会",
    "what for": "为什么",
    "who knows": "谁知道呢",
    "it is up to you": "你决定",
    "your call": "你决定",
    "i will do my best": "我会尽力",
    "i will try": "我试试",
    "it is not easy": "这不容易",
    "it is easy": "这很简单",
    "it takes time": "这需要时间",
    "no rush": "不着急",
    "take your time": "慢慢来",
    # ---- 学习 / 课堂 / 考试 ----
    "i do not know the answer": "我不知道答案",
    "how do you pronounce this word": "这个单词怎么读",
    "what does this word mean": "这个单词什么意思",
    "can you give me an example": "能给我举个例子吗",
    "i need more time": "我需要更多时间",
    "could you repeat the question": "你能重复一下问题吗",
    "i did not finish": "我没做完",
    "the exam is next week": "考试在下周",
    "i passed the exam": "我考试通过了",
    "i failed the exam": "我考试没通过",
    "i am preparing for the exam": "我在准备考试",
    "i need to review": "我需要复习",
    "take notes": "记笔记",
    "read the passage": "读这段文章",
    "summarize the main idea": "总结主旨",
    "let us go over it again": "我们再过一遍",
    "i understand now": "我现在明白了",
    "i still do not understand": "我还是不明白",
    "could you slow down": "你能慢一点吗",
    "could you give me a hint": "能给点提示吗",
    # ---- 出行 / 餐厅 / 购物 / 酒店 ----
    "where is the bathroom": "洗手间在哪",
    "where is the restroom": "洗手间在哪",
    "where is the station": "车站在哪",
    "how do i get to the airport": "去机场怎么走",
    "how far is it": "有多远",
    "is it far": "远吗",
    "i would like a coffee": "我要一杯咖啡",
    "can i have the menu": "能给我菜单吗",
    "the check please": "买单",
    "can i have the bill": "能买单吗",
    "do you have a table for two": "有两个人的位子吗",
    "i am just looking": "我随便看看",
    "do you have this in a bigger size": "这个有大一号的吗",
    "do you have this in a smaller size": "这个有小一号的吗",
    "can i try it on": "我能试穿吗",
    "i would like to check in": "我要办理入住",
    "i would like to check out": "我要退房",
    "my flight is delayed": "我的航班延误了",
    "my flight is cancelled": "我的航班取消了",
    "where is gate twelve": "十二号登机口在哪",
    "i lost my luggage": "我的行李丢了",
    "could you call a taxi for me": "能帮我叫辆出租车吗",
    "keep the change": "不用找零了",
    "i am allergic to peanuts": "我对花生过敏",
    "no spicy please": "不要辣",
    "it is delicious": "很好吃",
    "i am full": "我吃饱了",
    "the bill is wrong": "账单不对",
    "can i pay by phone": "我能手机支付吗",
    "do you have wifi": "你们有无线网吗",
    "what is the password": "密码是什么",
    "i need help": "我需要帮助",
    "please help me": "请帮帮我",
}

# ---------------------------------------------------------------- 单词库
#
# 只用于「用户只输入一个词」的情况。整句仍然交给模型 —— 把逐词释义拼成句子
# 只会得到一堆读不通的中文，那比模型译文更糟。
#
# 释义只给**常用义**，不冒充完整词典：一个词有五个义项时这里只写最常见的一条。

WORDS: dict[str, str] = {
    # 日常
    "hello": "你好；喂（打招呼）",
    "hi": "嗨；你好",
    "thanks": "谢谢",
    "sorry": "对不起；抱歉",
    "please": "请",
    "okay": "好的；可以",
    "yes": "是；对",
    "no": "不；不是",
    "maybe": "也许",
    "welcome": "欢迎",
    "goodbye": "再见",
    "water": "水",
    "coffee": "咖啡",
    "tea": "茶",
    "food": "食物",
    "money": "钱",
    "time": "时间",
    "today": "今天",
    "tomorrow": "明天",
    "yesterday": "昨天",
    "morning": "早上",
    "afternoon": "下午",
    "evening": "傍晚；晚上",
    "night": "夜晚",
    "week": "星期；周",
    "month": "月",
    "year": "年",
    "hour": "小时",
    "minute": "分钟",
    "friend": "朋友",
    "family": "家人；家庭",
    "home": "家",
    "work": "工作",
    "school": "学校",
    "office": "办公室",
    "phone": "电话",
    "email": "电子邮件",
    "message": "消息",
    "question": "问题",
    "answer": "回答；答案",
    "problem": "问题；麻烦",
    "help": "帮助",
    "idea": "主意；想法",
    "reason": "原因",
    "example": "例子",
    "word": "单词；词",
    "sentence": "句子",
    "language": "语言",
    "english": "英语",
    "chinese": "中文；汉语",
    "japanese": "日语",
    "korean": "韩语",
    "russian": "俄语",
    # 商务 / 术语
    "invoice": "发票",
    "receipt": "收据",
    "contract": "合同",
    "agreement": "协议",
    "deadline": "截止日期",
    "quotation": "报价；报价单",
    "quote": "报价；引用",
    "delivery": "交货；配送",
    "refund": "退款",
    "warranty": "保修",
    "deposit": "定金；押金",
    "installment": "分期付款",
    "interest": "利息；兴趣",
    "revenue": "收入；营收",
    "profit": "利润",
    "margin": "利润率；边缘",
    "budget": "预算",
    "schedule": "日程；安排",
    "agenda": "议程",
    "minutes": "会议纪要",
    "stakeholder": "利益相关方",
    "milestone": "里程碑",
    "compliance": "合规",
    "audit": "审计",
    "inventory": "库存",
    "logistics": "物流",
    "supplier": "供应商",
    "client": "客户",
    "proposal": "方案；提议",
    "approval": "批准",
    "negotiation": "谈判",
    "shipment": "货运；发货",
    "customs": "海关",
    "tariff": "关税",
    "merger": "合并",
    "acquisition": "收购",
    "shareholder": "股东",
    "dividend": "股息；分红",
    "asset": "资产",
    "liability": "负债",
    "forecast": "预测",
    "strategy": "战略",
    "objective": "目标",
    "meeting": "会议",
    "report": "报告",
    "project": "项目",
    "presentation": "演示；汇报",
    "feedback": "反馈",
    "estimate": "估算",
    "purchase": "购买",
    "payment": "付款",
    "balance": "余额；平衡",
    "discount": "折扣",
    "tax": "税",
    "salary": "工资",
    "expense": "开支；费用",
    "investment": "投资",
    "risk": "风险",
    "policy": "政策",
    "regulation": "法规",
    "evidence": "证据",
    "research": "研究",
    "analysis": "分析",
    "data": "数据",
    "result": "结果",
    "process": "过程；流程",
    "system": "系统",
    "method": "方法",
    "approach": "方法；途径",
    "solution": "解决方案",
    "challenge": "挑战",
    "opportunity": "机会",
    "advantage": "优势",
    "disadvantage": "劣势",
    "impact": "影响",
    "benefit": "好处；益处",
    "consequence": "后果",
    "condition": "条件；状况",
    "environment": "环境",
    "resource": "资源",
    "energy": "能源；精力",
    "technology": "技术",
    "industry": "行业；工业",
    "economy": "经济",
    "culture": "文化",
    "society": "社会",
    "education": "教育",
    "health": "健康",
    "safety": "安全",
    "quality": "质量",
    "quantity": "数量",
    "standard": "标准",
    "value": "价值",
    "price": "价格",
    "cost": "成本；费用",
    "market": "市场",
    "customer": "顾客",
    "product": "产品",
    "service": "服务",
    "order": "订单；顺序",
    "supply": "供应",
    "demand": "需求",
    "growth": "增长",
    "decline": "下降",
    "increase": "增加",
    "decrease": "减少",
    "improve": "改善；提高",
    "reduce": "减少",
    "achieve": "实现；达到",
    "require": "需要；要求",
    "provide": "提供",
    "support": "支持",
    "include": "包括",
    "contain": "包含",
    "involve": "涉及",
    "affect": "影响",
    "cause": "导致；原因",
    "avoid": "避免",
    "prevent": "防止",
    "consider": "考虑",
    "suggest": "建议",
    "recommend": "推荐",
    "explain": "解释",
    "describe": "描述",
    "discuss": "讨论",
    "compare": "比较",
    "decide": "决定",
    "choose": "选择",
    "prepare": "准备",
    "complete": "完成",
    "continue": "继续",
    "start": "开始",
    "finish": "结束；完成",
    "wait": "等待",
    "change": "改变",
    "check": "检查",
    "confirm": "确认",
    "cancel": "取消",
    "delay": "延迟",
    "arrange": "安排",
    "attend": "参加；出席",
    "apply": "申请；适用",
    "accept": "接受",
    "agree": "同意",
    "disagree": "不同意",
    "promise": "承诺",
    "apologize": "道歉",
    "complain": "抱怨",
    "thank": "感谢",
    "understand": "理解",
    "remember": "记得",
    "forget": "忘记",
    "believe": "相信",
    "realize": "意识到",
    "notice": "注意到",
    "imagine": "想象",
    "expect": "期望；预计",
    "hope": "希望",
    "worry": "担心",
    "enjoy": "享受；喜欢",
    "prefer": "更喜欢",
    "need": "需要",
    "want": "想要",
    "seem": "似乎",
    "become": "变成",
    "happen": "发生",
    "appear": "出现；似乎",
    "remain": "保持；仍然是",
    "exist": "存在",
    "belong": "属于",
    "depend": "依赖；取决于",
    "matter": "要紧；事情",
    "deal": "处理；交易",
    "handle": "处理",
    "manage": "管理；设法做到",
    "solve": "解决",
    "create": "创造",
    "produce": "生产；产生",
    "build": "建造",
    "develop": "发展；开发",
    "design": "设计",
    "prove": "证明",
    "show": "展示；表明",
    "reveal": "揭示",
    "indicate": "表明",
    "represent": "代表",
    "express": "表达",
    "communicate": "沟通",
    "contact": "联系",
    "reply": "回复",
    "respond": "回应",
    "share": "分享",
    "offer": "提供；提议",
    "refuse": "拒绝",
    "forbid": "禁止",
}


# ---------------------------------------------------------------- 多语言问候/常用语
#
# 日/韩/俄走「→英→中」两级，中间那句英语会把「こんにちは → Hello. → 哈罗」这种
# 变体带进来。日常问候是最高频、也最不该出错的，所以单独直出，不让它过模型。
#
# 只收「一句话就是一句话」的表达：整句寒暄、求助、问价、问路。带变量的句子
# （明天几点、多少钱）不放 —— 那需要模型或规则，硬套会给出错的事实。

MULTI: dict[str, dict[str, str]] = {
    "ja": {
        "こんにちは": "你好",
        "おはようございます": "早上好",
        "おはよう": "早上好",
        "こんばんは": "晚上好",
        "おやすみなさい": "晚安",
        "ありがとう": "谢谢",
        "ありがとうございます": "谢谢您",
        "どうも": "谢谢",
        "すみません": "不好意思",
        "ごめんなさい": "对不起",
        "はい": "是",
        "いいえ": "不是",
        "さようなら": "再见",
        "また明日": "明天见",
        "またね": "回头见",
        "お元気ですか": "你好吗",
        "はじめまして": "初次见面",
        "よろしくお願いします": "请多关照",
        "いただきます": "我开动了",
        "ごちそうさまでした": "我吃饱了，谢谢",
        "大丈夫です": "没问题",
        "わかりました": "明白了",
        "わかりません": "我不明白",
        "もう一度言ってください": "请再说一遍",
        "ゆっくり話してください": "请说慢一点",
        "いくらですか": "多少钱",
        "何時ですか": "几点",
        "トイレはどこですか": "洗手间在哪",
        "お願いします": "拜托了",
        "失礼します": "打扰了",
        "お疲れ様です": "辛苦了",
        "そうですね": "是啊",
        "ちょっと待ってください": "请稍等",
        "助けてください": "请帮帮我",
        "英語は話せますか": "你会说英语吗",
        "書いてもらえますか": "能帮我写下来吗",
    },
    "ko": {
        "안녕하세요": "你好",
        "안녕히 가세요": "再见（对离开的人）",
        "안녕히 계세요": "再见（对留下的人）",
        "감사합니다": "谢谢",
        "고맙습니다": "谢谢",
        "죄송합니다": "对不起",
        "미안합니다": "对不起",
        "네": "是",
        "아니요": "不是",
        "실례합니다": "打扰一下",
        "괜찮아요": "没关系",
        "모르겠어요": "我不知道",
        "다시 말해 주세요": "请再说一遍",
        "천천히 말해 주세요": "请说慢一点",
        "얼마예요": "多少钱",
        "몇 시예요": "几点",
        "화장실이 어디예요": "洗手间在哪",
        "부탁합니다": "拜托了",
        "잘 먹겠습니다": "我开动了",
        "수고하셨습니다": "辛苦了",
        "잠시만 기다려 주세요": "请稍等",
        "도와주세요": "请帮帮我",
        "만나서 반갑습니다": "很高兴认识你",
        "내일 봐요": "明天见",
        "좋아요": "好",
        "싫어요": "不要",
        "알겠습니다": "明白了",
        "영어 하세요": "你会说英语吗",
        "써 주시겠어요": "能帮我写下来吗",
    },
    "ru": {
        "здравствуйте": "您好",
        "привет": "嗨",
        "доброе утро": "早上好",
        "добрый день": "下午好",
        "добрый вечер": "晚上好",
        "спокойной ночи": "晚安",
        "спасибо": "谢谢",
        "большое спасибо": "非常感谢",
        "пожалуйста": "请；不客气",
        "извините": "对不起；打扰一下",
        "простите": "对不起",
        "да": "是",
        "нет": "不是",
        "до свидания": "再见",
        "до завтра": "明天见",
        "как дела": "你好吗",
        "очень приятно": "很高兴认识你",
        "я не понимаю": "我不明白",
        "повторите пожалуйста": "请再说一遍",
        "говорите медленнее": "请说慢一点",
        "сколько это стоит": "这个多少钱",
        "который час": "现在几点",
        "где туалет": "洗手间在哪",
        "помогите пожалуйста": "请帮帮我",
        "хорошо": "好",
        "понятно": "明白了",
        "подождите минуту": "请稍等",
        "вы говорите по-английски": "你会说英语吗",
        "напишите пожалуйста": "请写下来",
    },
}


#: 多语言索引：查询前先归一化（去掉「。」「!」、连字符、重复空格），
#: 否则「こんにちは。」和「こんにちは」会变成两条不同的键。
_MULTI_INDEX: dict[tuple[str, str], str] = {
    (lang, normalize(text)): zh
    for lang, table in MULTI.items()
    for text, zh in table.items()
}


@dataclass
class Hit:
    """命中结果。`kind` 决定界面怎么标：句子库 / 词义。"""

    translation: str
    kind: str  # 'sentence' | 'word'
    key: str
    #: 命中的是拼写变体（hellow → hello）。界面可以提示「按 hello 理解」。
    corrected: bool


def lookup(text: str, language: str = "en") -> Hit | None:
    """查常用语库。只做整句 / 单词的精确匹配（归一化后）。

    `language` 是**原文**的语言。非英语只查多语言问候表 —— 英文那张 391 句的
    表拿日语去匹配，命中的必然是错的那条。
    """
    key = normalize(text)
    if not key:
        return None

    raw = _SPACE.sub(" ", _PUNCT.sub(" ", (text or "").strip().lower())).strip()
    corrected = key != raw

    if language != "en":
        hit = _MULTI_INDEX.get((language, key))
        if hit:
            return Hit(translation=hit, kind="sentence", key=key, corrected=corrected)
        return None

    sentence = SENTENCES.get(key)
    if sentence:
        return Hit(translation=sentence, kind="sentence", key=key, corrected=corrected)

    # 单词：只有一个词才查词表。多词一律交给模型 —— 逐词直译拼不出通顺中文。
    if " " not in key:
        gloss = WORDS.get(key)
        if gloss:
            return Hit(translation=gloss, kind="word", key=key, corrected=corrected)
    return None


# ---------------------------------------------------------------- 退化自检

_REPEAT_CHAR = re.compile(r"(.)\1{3,}")
_REPEAT_WORD = re.compile(r"\b(\w+)(?:\s+\1\b){2,}", re.IGNORECASE)


def looks_degenerate(source: str, translation: str, latin_source: bool = True) -> tuple[bool, str]:
    """译文是不是「模型坏掉」的产物。

    实测三类，全部来自本地量化模型的短句退化：
      1. 原文原样吐回（`hi` -> `hi hi hi`、`hellow` -> `hellow`）
      2. 同一个字连续重复（`hello` -> `哈哈哈哈哈哈哈哈哈`、`Good morning` -> `早早早早早`）
      3. 同一个词重复三遍以上（`hi hi hi`）

    这不是「翻译质量评分」——判据只抓**不可能是正常译文**的形态。命中时上层
    要么换一路引擎，要么如实告诉用户「这句没翻出来」，都不能把结果当成功展示。

    `latin_source=False` 用于日语/韩语/俄语：那两条基于「英文单词数」的判据套在
    没有空格的语言上会误判（一整句被算成 1 个词），所以只保留字符级重复检查。
    """
    out = (translation or "").strip()
    if not out:
        return True, "empty"

    if _REPEAT_CHAR.search(out):
        return True, "repeat-char"
    if _REPEAT_WORD.search(out):
        return True, "repeat-word"

    if not latin_source:
        return False, ""

    src_key = normalize(source)
    out_key = normalize(out)
    if src_key and out_key and src_key == out_key:
        return True, "echo"

    # 译文长度失控：英文 3 个词译成 40 个汉字，基本是解码跑飞了。
    src_words = len(src_key.split()) if src_key else 0
    if src_words and len(out) > max(24, src_words * 12):
        return True, "too-long"
    return False, ""


_CLAUSE_BREAK = re.compile(r"[，,。.；;、！!？?]")


def drop_repeated_tail(text: str) -> str:
    """砍掉模型在句尾复述一遍的残句。

    实测（本地量化 en→zh 模型，确定性复现，不是偶发）：

        We will meet you at three o'clock  ->  三点见,三点
        See you tomorrow                   ->  明天见,明天

    它不是同词重复（逗号两侧不同字），`no_repeat_ngram` 也抓不到 —— 复述发生在
    字符层面。判据刻意收得很窄：**只看最后一段**，且它必须完整出现在前面的内容里。
    这样「我们三点见,三点之前到」不会被误砍（尾段前面没有），「你好,谢谢」也不会。

    宁可漏砍：把用户本来就说的话砍掉，比多留一个残句危险得多。
    """
    out = (text or "").strip()
    if not out:
        return out
    breaks = list(_CLAUSE_BREAK.finditer(out))
    if not breaks:
        return out
    parts = [p.strip() for p in _CLAUSE_BREAK.split(out)]
    parts = [p for p in parts if p]
    if len(parts) < 2:
        return out
    tail = parts[-1]
    head = "".join(parts[:-1])
    # 尾段必须够短（不超过前半的一半）才当残句，防止把一整句正常内容砍掉。
    if tail and tail in head and len(tail) * 2 <= len(head) + 1:
        trimmed = out[: breaks[-1].start()].strip()
        return trimmed or out
    return out
