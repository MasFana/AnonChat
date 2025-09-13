
import HomeClient from './pageClient';

export default function Home({ searchParams }: { searchParams: { [key: string]: string | string[] | undefined } }) {
  const msg = typeof searchParams.msg === 'string' ? searchParams.msg : null;
  return <HomeClient initialMsg={msg} />;
}
