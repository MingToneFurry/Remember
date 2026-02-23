Base url:
    https://uapis.cn/api/v1/social/bilibili/videoinfo?aid={{aid}}&bvid={{bvid}}

网页使用此api时，应该获取从 docx/allVid.md 文档所述api内，获取播放量排前10的视频简介及视频和核心数据
    
aid
string
视频的AV号 (aid)，纯数字格式。aid和bvid任选其一即可。

bvid
string
视频的BV号 (bvid)，例如 BV117411r7R1。aid和bvid任选其一即可。

响应体字段说明
copyright (视频类型): 1 代表原创，2 代表转载。
owner (UP主信息): 包含 mid, name, face 等UP主的基本资料。
stat (数据统计): 包含了播放、弹幕、评论、点赞、投币、收藏、分享等核心数据。
pages (分P列表): 这是一个数组，包含了视频的每一个分P的信息，即使是单P视频也会有一个元素。

返回示例：
```json
{
  "bvid": "BV1RV6bBqEVV",
  "aid": 115995926599288,
  "videos": 1,
  "tid": 136,
  "tname": "",
  "copyright": 1,
  "pic": "http://i2.hdslb.com/bfs/archive/8942fcd508916e63228ce272cd4183a2c9e77a50.jpg",
  "title": "【生贺特辑】生日到了，当然要打双重间谍啦！生日快乐！（Double Agent IN Lv.15 All Perfect手元）",
  "pubdate": 1770249600,
  "ctime": 1769957512,
  "desc": "日期：2026年2月5日\n玩家：BS_Beize\n曲：「双重间谍（Double Agent）」by：wav.av\n难度：IN Lv.15\n谱师：Spy-Simon_Axis | Spy-騎士\n设备：iPad Air 2\n\n啊嘿！北泽在此，今天是本体16岁的生日，所以我自然地就选择了双重间谍作为生贺手元的曲子。而前面发的一系列手元视频正是对这个“大餐”的预告。（细节：手元顺序是节奏大师精选集中IN难度的排序）\n按照IN难度排序，双重间谍是最难的，同时也是一张十分有新意的铺面，曲子也十分耐听。本张谱面对“双重间谍”的解释可谓是十分详尽，黄键和长条代表“双重间谍”，中间4k还原本家，结尾的反手引导出张更是神来之笔，整体打下来十分的舒适。Simon和Knight老师好强！（另提一嘴，Simon的其他谱面我也是非常喜欢的，可谓是phigros走向新时代以来我最喜欢的一个谱师了）\n关于这期视频的剪辑手法在之前玩双重间谍的时候我就已经构思好了，而“白天”和“黑夜”的转换则是在之前的视频里使用过一次，感兴趣可以去翻翻看。\n小插曲：当时我准备把这期手元做成联合的形式，但是没摇来人qwq\n当up主一年半了，我也在不断尝试新的剪辑手法，视频也从最开始的僵硬变得有了活力，也感谢各位的支持。（我认为我视频的最大风格：娓娓道来）\n最后希望大家喜欢这次的手元！",
  "desc_v2": [
    {
      "raw_text": "日期：2026年2月5日\n玩家：BS_Beize\n曲：「双重间谍（Double Agent）」by：wav.av\n难度：IN Lv.15\n谱师：Spy-Simon_Axis | Spy-騎士\n设备：iPad Air 2\n\n啊嘿！北泽在此，今天是本体16岁的生日，所以我自然地就选择了双重间谍作为生贺手元的曲子。而前面发的一系列手元视频正是对这个“大餐”的预告。（细节：手元顺序是节奏大师精选集中IN难度的排序）\n按照IN难度排序，双重间谍是最难的，同时也是一张十分有新意的铺面，曲子也十分耐听。本张谱面对“双重间谍”的解释可谓是十分详尽，黄键和长条代表“双重间谍”，中间4k还原本家，结尾的反手引导出张更是神来之笔，整体打下来十分的舒适。Simon和Knight老师好强！（另提一嘴，Simon的其他谱面我也是非常喜欢的，可谓是phigros走向新时代以来我最喜欢的一个谱师了）\n关于这期视频的剪辑手法在之前玩双重间谍的时候我就已经构思好了，而“白天”和“黑夜”的转换则是在之前的视频里使用过一次，感兴趣可以去翻翻看。\n小插曲：当时我准备把这期手元做成联合的形式，但是没摇来人qwq\n当up主一年半了，我也在不断尝试新的剪辑手法，视频也从最开始的僵硬变得有了活力，也感谢各位的支持。（我认为我视频的最大风格：娓娓道来）\n最后希望大家喜欢这次的手元！",
      "type": 1,
      "biz_id": 0
    }
  ],
  "state": 0,
  "duration": 191,
  "rights": {
    "bp": 0,
    "elec": 0,
    "download": 1,
    "movie": 0,
    "pay": 0,
    "hd5": 0,
    "no_reprint": 1,
    "autoplay": 1,
    "ugc_pay": 0,
    "is_cooperation": 0,
    "ugc_pay_preview": 0,
    "no_background": 0,
    "clean_mode": 0,
    "is_stein_gate": 0,
    "is_360": 0,
    "no_share": 0,
    "arc_pay": 0,
    "free_watch": 0
  },
  "owner": {
    "mid": 1933865292,
    "name": "账号已注销",
    "face": "https://i0.hdslb.com/bfs/face/member/noface.jpg"
  },
  "stat": {
    "aid": 115995926599288,
    "view": 337,
    "danmaku": 2,
    "reply": 17,
    "favorite": 10,
    "coin": 23,
    "share": 1,
    "now_rank": 0,
    "his_rank": 0,
    "like": 57,
    "dislike": 0,
    "evaluation": "",
    "vt": 0
  },
  "dynamic": "",
  "cid": 35755853932,
  "dimension": {
    "width": 1920,
    "height": 1080,
    "rotate": 0
  },
  "no_cache": false,
  "pages": [
    {
      "cid": 35755853932,
      "page": 1,
      "from": "vupload",
      "part": "【生贺特辑】生日到了，当然要打双重间谍啦！生日快乐！（Double Agent IN Lv.15 All Perfect手元）",
      "duration": 191,
      "vid": "",
      "weblink": "",
      "dimension": {
        "width": 1920,
        "height": 1080,
        "rotate": 0
      }
    }
  ],
  "subtitle": {
    "allow_submit": false,
    "list": []
  },
  "staff": null,
  "ugc_season": null,
  "is_chargeable_season": false,
  "is_story": false,
  "honor_reply": {
    "honor": null
  }
}
```