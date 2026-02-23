此项目为有感而发，或许是翻关注列表看到了太多的已注销用户吧
项目简介：
    通过Cloudflare实现自动生成网页、commit然后通过Github actions自动构建推送到Cloudflare实现生成用户纪念页的功能
项目核心：
    通过 docx/api.md 内列出的几个api，获取用户的投稿、观看量最高的前几个视频、用户的评论、视频、直播弹幕等信息，并交给grok-4.1-expert模型进行用户的分析，最后生成独属于该uid用户的纪念页面，同时自动更新和生成Sitemap，以及清除Cloudflare缓存（变动页面），在首页提供给用户输入uid然后生成专属页面的方式，同时首页还要有个地方展示最近生成的页面，注意接口需要使用Cloudflare turnstile进行保护，网页将会部署在 rem.furry.ist ，除了必要接口，其余均要可缓存

文档：

example\readme.md
docx\api.md