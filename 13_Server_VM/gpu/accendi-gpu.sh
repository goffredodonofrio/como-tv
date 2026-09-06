#!/usr/bin/env bash
# Accende una macchina GPU in eu-west-3 (la regione del bucket) che trascrive
# le telecronache e si spegne da sola quando ha finito.
#
# Prerequisiti (una volta): chiave AWS con EC2 e S3 in /etc/comotv/aws-gpu.env
#   AWS_ACCESS_KEY_ID=…  AWS_SECRET_ACCESS_KEY=…  AWS_DEFAULT_REGION=eu-west-3
# e la lista delle partite gia' scritta su s3://<bucket>/MAM/parlato/lista.json
# (la fa la VM: azione clip-parlato-lista).
#
# Uso:  ./accendi-gpu.sh [--solo como] [--max 400] [--tipo g5.xlarge] [--quante 1]
set -euo pipefail
BUCKET="${COMOTV_S3_BUCKET:-mola-italy-como-archive}"
TIPO="g5.xlarge"          # A10G 24 GB: large-v3 in float16 a ~30x tempo reale
QUANTE=1
EXTRA=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tipo) TIPO="$2"; shift 2;;
    --quante) QUANTE="$2"; shift 2;;
    --solo|--max) EXTRA="$EXTRA $1 $2"; shift 2;;
    *) echo "argomento sconosciuto: $1"; exit 1;;
  esac
done
set -a; . /etc/comotv/aws-gpu.env; set +a

# L'AMI Deep Learning di AWS (Ubuntu, PyTorch con CUDA): l'ultima disponibile
AMI=$(aws ec2 describe-images --owners amazon \
  --filters "Name=name,Values=Deep Learning OSS Nvidia Driver AMI GPU PyTorch * (Ubuntu 22.04) *" "Name=state,Values=available" \
  --query "sort_by(Images,&CreationDate)[-1].ImageId" --output text)
echo "AMI: $AMI"

# il ruolo IAM della macchina: legge il bucket e scrive in MAM/parlato/
PROFILO="${COMOTV_GPU_PROFILO:-comotv-parlato}"

# lo script che la macchina esegue all'accensione
UD=$(mktemp)
cat > "$UD" <<EOF
#!/bin/bash
set -x
export DEBIAN_FRONTEND=noninteractive
apt-get install -y -qq ffmpeg >/dev/null 2>&1 || true
sudo -u ubuntu bash -lc '
  source activate pytorch 2>/dev/null || true
  pip install -q whisperx boto3
  aws s3 cp s3://$BUCKET/MAM/parlato/lavoratore-parlato.py /home/ubuntu/lavoratore-parlato.py
  cd /home/ubuntu && python3 lavoratore-parlato.py --bucket $BUCKET --prefisso MAM/parlato/ --modello large-v3 --lingua it $EXTRA 2>&1 | tee /home/ubuntu/lavoro.log
'
EOF

aws ec2 run-instances \
  --image-id "$AMI" --instance-type "$TIPO" --count "$QUANTE" \
  --iam-instance-profile "Name=$PROFILO" \
  --instance-initiated-shutdown-behavior terminate \
  --instance-market-options 'MarketType=spot,SpotOptions={SpotInstanceType=one-time,InstanceInterruptionBehavior=terminate}' \
  --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=100,VolumeType=gp3,DeleteOnTermination=true}' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=comotv-parlato},{Key=Progetto,Value=MAM}]' \
  --user-data "file://$UD" \
  --query "Instances[].InstanceId" --output text
rm -f "$UD"
echo "accesa. Stato: aws ec2 describe-instances --filters Name=tag:Name,Values=comotv-parlato --query 'Reservations[].Instances[].[InstanceId,State.Name,PublicIpAddress]' --output table"
