# LuxVM FLUX.2 image service

This Worker keeps the Cloudflare API token on the server. Do not put the Cloudflare API token in LuxVM, GitHub Pages, or any client-side environment variable.

## Deploy

1. Create a Cloudflare API token with **Workers AI - Read** permission for the account that will run the model.
2. From this directory, install Wrangler if needed and run `npx wrangler login`.
3. Set the three secrets (use your own values):

```sh
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
npx wrangler secret put CLOUDFLARE_API_TOKEN
npx wrangler secret put LUXVM_ACCESS_KEY
```

- `CLOUDFLARE_ACCOUNT_ID`: your Cloudflare account ID.
- `CLOUDFLARE_API_TOKEN`: the API token with Workers AI Read permission.
- `LUXVM_ACCESS_KEY`: a long, random private key that you create. This is separate from the Cloudflare API token.

4. Deploy:

```sh
npx wrangler deploy
```

5. Copy the deployed Worker URL into LuxVM Settings → Image generation provider → Cloudflare FLUX.2 Klein 4B. Paste the same `LUXVM_ACCESS_KEY` into the Worker access key field and select Cloudflare in Image Studio.

## Allowed origins

By default, the Worker accepts the LuxVM GitHub Pages origin and the opaque `null` origin used by packaged Electron builds. To restrict or add origins, set `ALLOWED_ORIGINS` to a comma-separated list, for example:

```sh
npx wrangler secret put ALLOWED_ORIGINS
```

Include `https://ricecrackerlol.github.io` and `null` if both the website and packaged desktop app should work. The access key is still required; CORS is not authentication.

## Free allowance and limits

Cloudflare Workers AI currently includes 10,000 Neurons per day on the Free plan. FLUX.2 Klein 4B is billed by input and output 512×512 tiles, so the number of images depends on dimensions and reference inputs. The allowance resets daily at 00:00 UTC. Cloudflare can change pricing and limits; check its current pricing page.

Reference images are resized by LuxVM to fit within 512×512 before being sent to the model. The original gallery image is not changed. The Worker accepts one reference image per request, although the model supports up to four.

## Security note

The Worker access key is saved in LuxVM's local settings, just like the existing OpenRouter key. It is not a substitute for per-user authentication if you distribute the app publicly. For a public multi-user service, add Cloudflare Access or another user-authentication and rate-limiting layer before sharing the Worker URL.
