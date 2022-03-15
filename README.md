# SDLF CDK DATASET

- **Description**: Created this stack based on the existing AWS SDLF dataset creation solution
- **Rationale**: simplify deployment without the use funky bash scripts that make use of git diffs
- **Reference**: This original solution can be found here: https://github.com/awslabs/aws-serverless-data-lake-framework/tree/master/sdlf-dataset
- **Prerequisite**: AWS SDLF solution already deployed in your account
- **Functional**: Supports the creation of multiple datasets + registration in DynamoDB octagon tables
- **Usage**: In order to deploy: cdk deploy -c pTeamName=[teamname] -c pPipelineName=[pipelineName]
