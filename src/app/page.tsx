
import HomeClient from './pageClient';

export default async function Home({ searchParams }: { searchParams: { [key: string]: string | string[] | undefined } }) {
  const sp = await searchParams
  const msg = typeof  sp.msg === 'string' ? sp.msg : null;
  return <HomeClient initialMsg={msg} />;
}
