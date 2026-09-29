import type { SecretView } from '@klankish/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@shared/api/client';
import { EP } from '@shared/constants/endpoints';

const keys = { all: ['secrets'] as const };

export function useSecrets() {
  return useQuery({
    queryKey: keys.all,
    queryFn: async (): Promise<SecretView[]> => {
      const { data } = await api.get<SecretView[]>(EP.SECRETS.LIST);
      return data;
    },
  });
}

export function useCreateSecret() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { name: string; value: string }): Promise<SecretView> => {
      const { data } = await api.post<SecretView>(EP.SECRETS.CREATE, input);
      return data;
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: keys.all }); },
  });
}

export function useDeleteSecret() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<void> => { await api.delete(EP.SECRETS.DELETE(id)); },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: keys.all }); },
  });
}
