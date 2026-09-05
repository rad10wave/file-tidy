import { useEffect, useRef, useState } from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Stack, Switch, TextField, Typography } from '@mui/material';
import ExpandMoreRounded from '@mui/icons-material/ExpandMoreRounded';
import AddRounded from '@mui/icons-material/AddRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import FolderOutlined from '@mui/icons-material/FolderOutlined';
import type { Category } from '../core/types';

export function CategoriesDialog({ open, onClose, onSaved }: { open: boolean; onClose(): void; onSaved(): void }) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState<string | false>(false);
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    let current = true;
    setLoading(true); setError(''); setExpanded(false);
    window.fileTidy.getCategories().then((value) => { if (current) setCategories(value); })
      .catch((e) => { if (current) setError(String(e.message ?? e)); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [open]);
  const update = (id: string, patch: Partial<Category>) => setCategories((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));
  const save = async () => {
    setSaving(true); setError('');
    try { await window.fileTidy.saveCategories(categories); onSaved(); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };
  return <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="md" aria-labelledby="categories-title">
    <DialogTitle id="categories-title" sx={{ pb: 2 }}>
      <Stack direction="row" spacing={2} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <Box>Folders & file types<Typography component="p" variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>Select a category to edit its folder and extensions.</Typography></Box>
        <Button startIcon={<AddRounded />} variant="outlined" disabled={saving || loading} onClick={() => {
          const id = crypto.randomUUID();
          setCategories((items) => [{ id, name: 'New category', folder: 'New folder', enabled: true, extensions: [] }, ...items]);
          setExpanded(id);
          contentRef.current?.scrollTo({ top: 0 });
        }}>Add category</Button>
      </Stack>
    </DialogTitle>
    <DialogContent ref={contentRef} dividers sx={{ bgcolor: 'background.default', scrollbarGutter: 'stable' }}>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>Folders are created inside your selected location. Changes apply after you save.</Typography>
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {loading ? <Typography>Loading categories…</Typography> : <Box>
        {categories.map((category) => <Accordion key={category.id} disableGutters elevation={0} expanded={expanded === category.id} onChange={(_, value) => setExpanded(value ? category.id : false)} sx={{ mb: 1, border: 1, borderColor: expanded === category.id ? 'primary.main' : 'divider', borderRadius: '8px !important', '&:before': { display: 'none' } }}>
          <AccordionSummary expandIcon={<ExpandMoreRounded />} aria-controls={`category-${category.id}-content`} id={`category-${category.id}-header`} sx={{ minHeight: 60, '& .MuiAccordionSummary-content': { my: 1.25 } }}>
          <Stack direction="row" spacing={1.5} sx={{ width: '100%', pr: 1.5, alignItems: 'center', minWidth: 0 }}>
            <FolderOutlined color={category.enabled ? 'primary' : 'disabled'} />
            <Box sx={{ flex: 1, minWidth: 0 }}><Typography sx={{ fontWeight: 650 }} noWrap>{category.name || 'New category'}</Typography><Typography variant="caption" color="text.secondary" noWrap component="p">{category.folder}/</Typography></Box>
            <Chip size="small" label={category.enabled ? 'Active' : 'Paused'} variant="outlined" />
          </Stack>
          </AccordionSummary>
          <AccordionDetails sx={{ pt: 1, pb: 2 }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField label="Category name" size="small" fullWidth value={category.name} disabled={saving} onChange={(event) => update(category.id, { name: event.target.value })} />
            <TextField label="Destination folder" size="small" fullWidth value={category.folder} disabled={saving} onChange={(event) => update(category.id, { folder: event.target.value })} />
          </Stack>
          <TextField label="File extensions" placeholder="e.g. psd, ai, fig" size="small" fullWidth sx={{ mt: 2 }} value={category.extensions.join(',')} disabled={saving} onChange={(event) => update(category.id, { extensions: event.target.value.split(',') })} helperText={category.id === 'others' ? 'Also receives unmatched files when that option is enabled.' : 'Separate extensions with commas. Each type can belong to one active category.'} />
          <Stack direction="row" sx={{ mt: 1.5, alignItems: 'center', justifyContent: 'space-between' }}>
            <FormControlLabel sx={{ ml: 0 }} label="Category enabled" control={<Switch checked={category.enabled} disabled={saving} onChange={(_, checked) => update(category.id, { enabled: checked })} />} />
            <Button color="error" startIcon={<DeleteOutlineRounded />} disabled={saving || category.id === 'others'} onClick={() => setCategories((items) => items.filter((item) => item.id !== category.id))}>Remove category</Button>
          </Stack>
          </AccordionDetails>
        </Accordion>)}
      </Box>}
    </DialogContent>
    <DialogActions><Button onClick={onClose} disabled={saving}>Cancel</Button><Button variant="contained" onClick={save} disabled={loading || saving || !categories.length}>{saving ? 'Saving…' : 'Save changes'}</Button></DialogActions>
  </Dialog>;
}
