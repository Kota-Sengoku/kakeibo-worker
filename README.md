# 家計簿のデータの置き場所(Cloudflare)

家計簿アプリのデータを、あなた自身のCloudflare(無料)に保存するための部品です。
データは、あなたのCloudflareの中だけに入ります。

## つくり方

1. [Cloudflareの無料アカウント](https://dash.cloudflare.com/sign-up)を作る。
2. 家計簿アプリを開き、最初の画面の「① 合言葉を作る」を押して、合言葉をコピーする。
3. 下のボタンを押す。Cloudflareの画面で、`APP_KEY` に、②の合言葉を貼り付けて、デプロイする。

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Kota-Sengoku/kakeibo-worker)

4. 終わると表示される `https://kakeibo-app.○○.workers.dev` を、アプリの「③ つなぐ」に貼り付ける。

データベース(D1)は、デプロイのときに自動で作られ、つながります。表は、最初のアクセスで自動で作られます。

## 合言葉を変えたいとき
Cloudflare → Workers → kakeibo-app → 設定 → 変数とシークレット → `APP_KEY` を変えて、アプリの設定の「合言葉」も同じにしてください。
