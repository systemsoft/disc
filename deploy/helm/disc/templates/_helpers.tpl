{{/*
Expand the name of the chart.
*/}}
{{- define "disc.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars to honour the DNS naming spec.
*/}}
{{- define "disc.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Chart name and version (for the chart label).
*/}}
{{- define "disc.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels.
*/}}
{{- define "disc.labels" -}}
helm.sh/chart: {{ include "disc.chart" . }}
{{ include "disc.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: disc
{{- end -}}

{{/*
Selector labels.
*/}}
{{- define "disc.selectorLabels" -}}
app.kubernetes.io/name: {{ include "disc.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
ServiceAccount name to use.
*/}}
{{- define "disc.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "disc.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
Image reference. Defaults image.tag to .Chart.AppVersion when unset.
*/}}
{{- define "disc.imageReference" -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end -}}

{{/*
Name of the Secret managed by this chart.
*/}}
{{- define "disc.secretName" -}}
{{- printf "%s" (include "disc.fullname" .) -}}
{{- end -}}

{{/*
Resolve which Secret holds DATABASE_URL.
Returns the name to use in a secretKeyRef.
*/}}
{{- define "disc.databaseUrlSecretName" -}}
{{- if .Values.database.external.urlSecretRef.name -}}
{{- .Values.database.external.urlSecretRef.name -}}
{{- else -}}
{{- include "disc.secretName" . -}}
{{- end -}}
{{- end -}}

{{- define "disc.databaseUrlSecretKey" -}}
{{- if .Values.database.external.urlSecretRef.name -}}
{{- .Values.database.external.urlSecretRef.key | default "DATABASE_URL" -}}
{{- else -}}
DATABASE_URL
{{- end -}}
{{- end -}}

{{/*
Resolve which Secret holds DISC_JWT_SECRET.
*/}}
{{- define "disc.jwtSecretName" -}}
{{- if .Values.auth.jwtSecretRef.name -}}
{{- .Values.auth.jwtSecretRef.name -}}
{{- else -}}
{{- include "disc.secretName" . -}}
{{- end -}}
{{- end -}}

{{- define "disc.jwtSecretKey" -}}
{{- if .Values.auth.jwtSecretRef.name -}}
{{- .Values.auth.jwtSecretRef.key | default "DISC_JWT_SECRET" -}}
{{- else -}}
DISC_JWT_SECRET
{{- end -}}
{{- end -}}

{{/*
Emit the DATABASE_URL env var as a list item. Always pulled from a Secret.
*/}}
{{- define "disc.databaseUrlEnv" -}}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "disc.databaseUrlSecretName" . }}
      key: {{ include "disc.databaseUrlSecretKey" . }}
{{- end -}}

{{/*
Emit the DISC_JWT_SECRET env var as a list item. Always pulled from a Secret.
*/}}
{{- define "disc.jwtSecretEnv" -}}
- name: DISC_JWT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "disc.jwtSecretName" . }}
      key: {{ include "disc.jwtSecretKey" . }}
{{- end -}}

{{/*
Resolve the JWT secret value used at template-render time.
Order:
  1) literal .Values.auth.jwtSecret
  2) value already in the chart's existing Secret (preserved across upgrades)
  3) freshly generated 32-char alpha-numeric
Only used when secrets.create=true and no external jwtSecretRef is set.
*/}}
{{- define "disc.resolvedJwtSecret" -}}
{{- if .Values.auth.jwtSecret -}}
{{- .Values.auth.jwtSecret -}}
{{- else -}}
{{- $existing := lookup "v1" "Secret" .Release.Namespace (include "disc.secretName" .) -}}
{{- if and $existing $existing.data (index $existing.data "DISC_JWT_SECRET") -}}
{{- index $existing.data "DISC_JWT_SECRET" | b64dec -}}
{{- else -}}
{{- randAlphaNum 32 -}}
{{- end -}}
{{- end -}}
{{- end -}}
