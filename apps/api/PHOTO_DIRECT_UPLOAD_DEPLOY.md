# Photo direct-upload deployment marker

This file intentionally lives under `apps/api/` so Railway's API service redeploys the current `main` tree after the earlier photo presign route deployment failed. It has no runtime effect.
