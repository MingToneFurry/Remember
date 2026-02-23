此项目为有感而发，或许是翻关注列表看到了太多的已注销用户吧
项目简介：
    通过Cloudflare实现自动生成网页、commit然后通过Github actions自动构建推送到Cloudflare实现生成用户纪念页的功能
项目核心：
    通过 docx/api.md 内列出的几个api，获取用户的投稿、观看量最高的前几个视频、用户的评论、视频、直播弹幕等信息，并交给grok-4.1-expert模型进行用户的分析，最后生成独属于该uid用户的纪念页面，同时自动更新和生成Sitemap，以及清除Cloudflare缓存（变动页面）



文档：

example\readme.md
docx\api.md