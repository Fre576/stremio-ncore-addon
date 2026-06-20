import { api } from '@/api';
import { Alert } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useMe } from '@/hooks/use-me';
import { useQuery } from '@tanstack/react-query';
import { PropsWithChildren } from 'react';
import { Redirect } from 'wouter';
import { DeleteTorrentButton } from './components/delete-torrent-button';
import { DUPLICATE_TORRENTS_QUERY_KEY, TORRENTS_QUERY_KEY } from './constants';
import { UserRole } from '@server/db/schema/users';

const Container = ({ children }: PropsWithChildren) => (
  <div className="h-full pt-6 pb-24 flex flex-col space-y-8">
    <h1 className="text-2xl font-semibold text-center">Torrents</h1>
    {children}
  </div>
);

export const TorrentsPage = () => {
  const { data: user } = useMe();
  const {
    data: torrents,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: [TORRENTS_QUERY_KEY],
    queryFn: async () => {
      const req = await api.torrents.$get();
      return await req.json();
    },
    enabled: !!user && user.role === UserRole.ADMIN,
    refetchInterval: 10_000,
  });

  const { data: duplicateCandidates } = useQuery({
    queryKey: [DUPLICATE_TORRENTS_QUERY_KEY],
    queryFn: async () => {
      const req = await fetch('/api/torrents/duplicates');
      return await req.json();
    },
    enabled: !!user && user.role === UserRole.ADMIN,
    refetchInterval: 30_000,
  });

  const [animatedParent] = useAutoAnimate();

  if (user && user.role !== UserRole.ADMIN) {
    return <Redirect to="/account" />;
  }

  if (isError) {
    return (
      <Container>
        <Alert
          variant="error"
          title="An error occured while loading your torrents"
          description={error.message}
        />
      </Container>
    );
  }

  if (isLoading || !torrents) {
    return (
      <Container>
        <Skeleton />
      </Container>
    );
  }

  return (
    <Container>
      {!!duplicateCandidates?.length && (
        <div className="overflow-x-auto md:overflow-x-visible w-full">
          <Table className="w-full">
            <TableCaption>
              Duplicate candidates. Only completed torrents with ratio 1.00 or higher are
              listed here.
            </TableCaption>
            <TableHeader>
              <TableRow className="text-nowrap">
                <TableHead>Matched title</TableHead>
                <TableHead>Keep</TableHead>
                <TableHead>Can delete</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {duplicateCandidates.flatMap((candidate: any) =>
                candidate.deletable.map((torrent: any) => (
                  <TableRow key={`${candidate.duplicateKey}-${torrent.infoHash}`}>
                    <TableCell>
                      <span className="break-all line-clamp-3 overflow-hidden overflow-ellipsis">
                        {candidate.duplicateKey}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="break-all line-clamp-3 overflow-hidden overflow-ellipsis">
                        {candidate.keep.name}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="break-all line-clamp-3 overflow-hidden overflow-ellipsis">
                        {torrent.name}
                      </span>
                    </TableCell>
                    <TableCell>
                      {user?.role === UserRole.ADMIN && (
                        <DeleteTorrentButton
                          torrent={{
                            hash: torrent.infoHash,
                            name: torrent.name,
                            downloaded: `${(torrent.progress * 100).toFixed(2)}%`,
                            uploaded: `${torrent.ratio.toFixed(2)} ratio`,
                            ratio: torrent.ratio.toFixed(2),
                            progress: `${(torrent.progress * 100).toFixed(2)}%`,
                            size: `${(torrent.size / 1024 / 1024 / 1024).toFixed(2)} GB`,
                          }}
                        />
                      )}
                    </TableCell>
                  </TableRow>
                )),
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="overflow-x-auto md:overflow-x-visible w-full">
        <Table className="w-full">
          <TableCaption>Your currently active torrents</TableCaption>
          <TableHeader>
            <TableRow className="text-nowrap">
              <TableHead>
                <span>Release name</span>
              </TableHead>
              <TableHead>Downloaded</TableHead>
              <TableHead>Uploaded</TableHead>
              <TableHead>Ratio</TableHead>
              <TableHead>Total size</TableHead>
              <TableHead>Progress</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody ref={animatedParent}>
            {torrents.map((torrent) => (
              <TableRow key={torrent.hash}>
                <TableCell>
                  <span className="break-all line-clamp-3 overflow-hidden overflow-ellipsis">
                    {torrent.name}
                  </span>
                </TableCell>
                <TableCell>{torrent.downloaded}</TableCell>
                <TableCell>{torrent.uploaded}</TableCell>
                <TableCell>{torrent.ratio}</TableCell>
                <TableCell>{torrent.size}</TableCell>
                <TableCell>{torrent.progress}</TableCell>
                <TableCell>
                  {user?.role === UserRole.ADMIN && (
                    <DeleteTorrentButton torrent={torrent} />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Container>
  );
};
