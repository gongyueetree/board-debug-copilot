import { redirect } from 'next/navigation'
import { DEMO_PROJECT_ID } from '@/lib/nav'

export default function Home() {
  redirect(`/projects/${DEMO_PROJECT_ID}`)
}
